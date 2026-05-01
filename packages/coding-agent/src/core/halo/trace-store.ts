import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import {
	ensureHaloTraceIndex,
	haloIndexMetaPathFor,
	loadHaloTraceIndex,
	loadHaloTraceIndexMeta,
} from "./trace-index.js";
import type {
	HaloDatasetOverview,
	HaloOversizedTraceSummary,
	HaloSpanRecord,
	HaloTraceCountResult,
	HaloTraceFilters,
	HaloTraceIndexMeta,
	HaloTraceIndexRow,
	HaloTraceQueryResult,
	HaloTraceSearchResult,
	HaloTraceSummary,
	HaloTraceView,
} from "./types.js";

const OVERVIEW_SAMPLE_TRACE_IDS = 20;
const DISCOVERY_ATTR_TRUNCATION_CHARS = 4096;
const SURGICAL_ATTR_TRUNCATION_CHARS = 16384;
const VIEW_TRACE_CHAR_BUDGET = 150_000;
const OVERSIZED_TOP_SPAN_NAMES = 10;
const SEARCH_MATCH_LIMIT = 20;
const SEARCH_EXCERPT_CHARS = 1200;

const NOISY_FLAT_PROJECTION_RE = /^(?:llm\.(?:input|output)_messages|mcp\.tools)\.\d+\./;

export class HaloTraceStore {
	readonly tracePath: string;
	readonly indexPath: string;
	readonly rows: HaloTraceIndexRow[];
	readonly rowsById: Map<string, HaloTraceIndexRow>;
	readonly indexMeta: HaloTraceIndexMeta | undefined;

	private constructor(
		tracePath: string,
		indexPath: string,
		rows: HaloTraceIndexRow[],
		indexMeta?: HaloTraceIndexMeta,
	) {
		this.tracePath = tracePath;
		this.indexPath = indexPath;
		this.rows = rows;
		this.rowsById = new Map(rows.map((row) => [row.trace_id, row]));
		this.indexMeta = indexMeta;
	}

	static async load(tracePath: string, indexPath?: string): Promise<HaloTraceStore> {
		const resolvedIndexPath = await ensureHaloTraceIndex(tracePath, indexPath);
		const rows = await loadHaloTraceIndex(resolvedIndexPath);
		const indexMeta = await loadHaloTraceIndexMeta(haloIndexMetaPathFor(resolvedIndexPath)).catch(() => undefined);
		return new HaloTraceStore(tracePath, resolvedIndexPath, rows, indexMeta);
	}

	get traceCount(): number {
		return this.rows.length;
	}

	queryTraces(filters: HaloTraceFilters = {}, limit = 50, offset = 0): HaloTraceQueryResult {
		const filtered = this.rows.filter((row) => matchesFilters(row, filters));
		return {
			traces: filtered.slice(offset, offset + limit).map(toSummary),
			total: filtered.length,
		};
	}

	countTraces(filters: HaloTraceFilters = {}): HaloTraceCountResult {
		return { total: this.rows.filter((row) => matchesFilters(row, filters)).length };
	}

	getOverview(filters: HaloTraceFilters = {}): HaloDatasetOverview {
		const rows = this.rows.filter((row) => matchesFilters(row, filters));
		if (rows.length === 0) {
			return {
				total_traces: 0,
				total_spans: 0,
				earliest_start_time: "",
				latest_end_time: "",
				service_names: [],
				model_names: [],
				agent_names: [],
				error_trace_count: 0,
				total_input_tokens: 0,
				total_output_tokens: 0,
				sample_trace_ids: [],
				error_breakdown: createErrorBreakdown(rows),
				index_health: this.indexHealth(),
			};
		}

		return {
			total_traces: rows.length,
			total_spans: rows.reduce((sum, row) => sum + row.span_count, 0),
			earliest_start_time: rows.reduce(
				(min, row) => (row.start_time < min ? row.start_time : min),
				rows[0]?.start_time ?? "",
			),
			latest_end_time: rows.reduce((max, row) => (row.end_time > max ? row.end_time : max), rows[0]?.end_time ?? ""),
			service_names: collectSorted(rows, (row) => row.service_names),
			model_names: collectSorted(rows, (row) => row.model_names),
			agent_names: collectSorted(rows, (row) => row.agent_names),
			error_trace_count: rows.filter((row) => row.has_errors).length,
			total_input_tokens: rows.reduce((sum, row) => sum + row.total_input_tokens, 0),
			total_output_tokens: rows.reduce((sum, row) => sum + row.total_output_tokens, 0),
			sample_trace_ids: rows.slice(0, OVERVIEW_SAMPLE_TRACE_IDS).map((row) => row.trace_id),
			error_breakdown: createErrorBreakdown(rows),
			index_health: this.indexHealth(),
		};
	}

	async viewTrace(traceId: string): Promise<HaloTraceView> {
		const spans = (await this.readSpans(traceId)).map((span) =>
			truncateSpanAttributes(span, DISCOVERY_ATTR_TRUNCATION_CHARS),
		);
		const sizes = spans.map((span) => JSON.stringify(span).length);
		const totalChars = sizes.reduce((sum, size) => sum + size, 0);
		if (totalChars > VIEW_TRACE_CHAR_BUDGET) {
			return {
				trace_id: traceId,
				spans: [],
				oversized: createOversizedSummary(traceId, spans, sizes, totalChars),
			};
		}
		return { trace_id: traceId, spans };
	}

	async viewSpans(traceId: string, spanIds: string[]): Promise<HaloTraceView> {
		const wanted = new Set(spanIds);
		const spans = (await this.readSpans(traceId))
			.filter((span) => wanted.has(span.span_id))
			.map((span) => truncateSpanAttributes(span, SURGICAL_ATTR_TRUNCATION_CHARS));
		return { trace_id: traceId, spans };
	}

	async searchTrace(traceId: string, pattern: string): Promise<HaloTraceSearchResult> {
		const row = this.requireRow(traceId);
		const matches: string[] = [];
		let matchCount = 0;
		const file = await open(this.tracePath, "r");
		try {
			for (let i = 0; i < row.byte_offsets.length; i++) {
				const raw = await readSlice(file, row.byte_offsets[i] ?? 0, row.byte_lengths[i] ?? 0);
				if (!raw.includes(pattern)) continue;
				matchCount++;
				if (matches.length >= SEARCH_MATCH_LIMIT) continue;
				matches.push(summarizeSearchMatch(raw, pattern));
			}
		} finally {
			await file.close();
		}
		if (matchCount > matches.length) {
			matches.push(
				JSON.stringify({
					__halo_search_truncated: true,
					shown_matches: matches.length,
					total_matches: matchCount,
					hint: "Use a narrower pattern or halo_view_spans on the span ids above.",
				}),
			);
		}
		return { trace_id: traceId, match_count: matchCount, matches };
	}

	async renderTrace(traceId: string, budget = 32_000): Promise<string> {
		const view = await this.viewTrace(traceId);
		const lines = [`trace_id: ${traceId}`, `spans: ${view.spans.length}`];
		if (view.oversized) lines.push(`oversized: ${view.oversized.recommendation}`);
		for (const span of view.spans) {
			lines.push(
				`- span_id=${span.span_id} parent=${span.parent_span_id || "∅"} name=${span.name} kind=${span.kind} status=${span.status.code}`,
			);
			lines.push(`  start=${span.start_time} end=${span.end_time}`);
			const model = span.attributes["inference.llm.model_name"] ?? span.attributes["llm.model_name"];
			if (typeof model === "string") lines.push(`  model=${model}`);
			const inputTokens = span.attributes["inference.llm.input_tokens"];
			const outputTokens = span.attributes["inference.llm.output_tokens"];
			if (inputTokens !== undefined || outputTokens !== undefined)
				lines.push(`  tokens: input=${inputTokens} output=${outputTokens}`);
		}
		const rendered = lines.join("\n");
		return rendered.length > budget ? `${rendered.slice(0, budget)}... [truncated]` : rendered;
	}

	private async readSpans(traceId: string): Promise<HaloSpanRecord[]> {
		const row = this.requireRow(traceId);
		const file = await open(this.tracePath, "r");
		try {
			const spans: HaloSpanRecord[] = [];
			for (let i = 0; i < row.byte_offsets.length; i++) {
				try {
					spans.push(
						JSON.parse(
							await readSlice(file, row.byte_offsets[i] ?? 0, row.byte_lengths[i] ?? 0),
						) as HaloSpanRecord,
					);
				} catch {
					// The source trace may have been appended/rewritten while an index was being read.
					// Skip the bad slice so one corrupt span does not hide the rest of the trace.
				}
			}
			return spans;
		} finally {
			await file.close();
		}
	}

	private indexHealth(): HaloDatasetOverview["index_health"] {
		return {
			corrupt_span_count: this.indexMeta?.corrupt_span_count ?? 0,
			corrupt_span_bytes: this.indexMeta?.corrupt_span_bytes ?? 0,
			...(this.indexMeta?.first_corrupt_line !== undefined
				? { first_corrupt_line: this.indexMeta.first_corrupt_line }
				: {}),
		};
	}

	private requireRow(traceId: string): HaloTraceIndexRow {
		const row = this.rowsById.get(traceId);
		if (!row) throw new Error(`Unknown trace_id: ${traceId}`);
		return row;
	}
}

function matchesFilters(row: HaloTraceIndexRow, filters: HaloTraceFilters): boolean {
	if (filters.has_errors !== undefined && row.has_errors !== filters.has_errors) return false;
	if (filters.model_names !== undefined && !filters.model_names.some((model) => row.model_names.includes(model)))
		return false;
	if (
		filters.service_names !== undefined &&
		!filters.service_names.some((service) => row.service_names.includes(service))
	)
		return false;
	if (filters.agent_names !== undefined && !filters.agent_names.some((agent) => row.agent_names.includes(agent)))
		return false;
	if (filters.project_id !== undefined && row.project_id !== filters.project_id) return false;
	if (filters.start_time_gte !== undefined && row.start_time < filters.start_time_gte) return false;
	if (filters.end_time_lte !== undefined && row.end_time > filters.end_time_lte) return false;
	return true;
}

function toSummary(row: HaloTraceIndexRow): HaloTraceSummary {
	return {
		trace_id: row.trace_id,
		span_count: row.span_count,
		start_time: row.start_time,
		end_time: row.end_time,
		has_errors: row.has_errors,
		service_names: row.service_names,
		model_names: row.model_names,
		total_input_tokens: row.total_input_tokens,
		total_output_tokens: row.total_output_tokens,
		agent_names: row.agent_names,
		error_span_count: row.error_span_count,
		tool_error_count: row.tool_error_count,
		llm_error_count: row.llm_error_count,
		agent_error_count: row.agent_error_count,
		final_answer_present: row.final_answer_present,
		completed: row.completed,
		cancelled: row.cancelled,
	};
}

function createErrorBreakdown(rows: HaloTraceIndexRow[]): NonNullable<HaloDatasetOverview["error_breakdown"]> {
	return {
		error_spans: rows.reduce((sum, row) => sum + (row.error_span_count ?? (row.has_errors ? 1 : 0)), 0),
		tool_error_spans: rows.reduce((sum, row) => sum + (row.tool_error_count ?? 0), 0),
		llm_error_spans: rows.reduce((sum, row) => sum + (row.llm_error_count ?? 0), 0),
		agent_error_spans: rows.reduce((sum, row) => sum + (row.agent_error_count ?? 0), 0),
		completed_traces: rows.filter((row) => row.completed).length,
		cancelled_traces: rows.filter((row) => row.cancelled).length,
		traces_with_final_answer: rows.filter((row) => row.final_answer_present).length,
	};
}

function collectSorted(rows: HaloTraceIndexRow[], select: (row: HaloTraceIndexRow) => string[]): string[] {
	const values = new Set<string>();
	for (const row of rows) for (const value of select(row)) values.add(value);
	return [...values].sort();
}

function truncateSpanAttributes(span: HaloSpanRecord, cap: number): HaloSpanRecord {
	let dropped = 0;
	const attributes: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(span.attributes)) {
		if (NOISY_FLAT_PROJECTION_RE.test(key)) {
			dropped++;
			continue;
		}
		attributes[key] = truncateAttributeValue(value, cap);
	}
	if (dropped > 0) {
		attributes.__halo_dropped_flat_projections = `${dropped} flat llm/mcp projection keys dropped to keep span size bounded. JSON blob attributes carry the same content when present.`;
	}
	return { ...span, attributes };
}

function truncateAttributeValue(value: unknown, cap: number): unknown {
	if (typeof value === "string") {
		return value.length > cap ? `${value.slice(0, cap)}... [HALO truncated: original ${value.length} chars]` : value;
	}
	const serialized = safeJson(value);
	if (serialized === undefined || serialized.length <= cap) return value;
	return `${serialized.slice(0, cap)}... [HALO truncated: original ${serialized.length} chars; non-string attribute serialized for truncation]`;
}

function safeJson(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

function summarizeSearchMatch(raw: string, pattern: string): string {
	try {
		const span = JSON.parse(raw) as HaloSpanRecord;
		return JSON.stringify({
			span_id: span.span_id,
			parent_span_id: span.parent_span_id,
			name: span.name,
			status: span.status,
			start_time: span.start_time,
			end_time: span.end_time,
			tool_name: span.attributes["tool.name"],
			model_name: span.attributes["inference.llm.model_name"] ?? span.attributes["llm.model_name"],
			turn_index: span.attributes["pi.turn_index"],
			input_tokens: span.attributes["inference.llm.input_tokens"],
			output_tokens: span.attributes["inference.llm.output_tokens"],
			excerpt: excerptAround(raw, pattern, SEARCH_EXCERPT_CHARS),
		});
	} catch {
		return JSON.stringify({ corrupt_span: true, excerpt: excerptAround(raw, pattern, SEARCH_EXCERPT_CHARS) });
	}
}

function excerptAround(text: string, pattern: string, cap: number): string {
	const index = pattern.length > 0 ? text.indexOf(pattern) : 0;
	if (index < 0) return text.slice(0, cap);
	const before = Math.floor((cap - pattern.length) / 2);
	const start = Math.max(0, index - Math.max(0, before));
	const end = Math.min(text.length, start + cap);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < text.length ? "..." : "";
	return `${prefix}${text.slice(start, end)}${suffix}`;
}

function createOversizedSummary(
	traceId: string,
	spans: HaloSpanRecord[],
	sizes: number[],
	totalChars: number,
): HaloOversizedTraceSummary {
	const sorted = [...sizes].sort((a, b) => a - b);
	const counts = new Map<string, number>();
	for (const span of spans) counts.set(span.name, (counts.get(span.name) ?? 0) + 1);
	return {
		trace_id: traceId,
		span_count: spans.length,
		total_serialized_chars: totalChars,
		char_budget: VIEW_TRACE_CHAR_BUDGET,
		span_size_min: sorted[0] ?? 0,
		span_size_median: sorted[Math.floor(sorted.length / 2)] ?? 0,
		span_size_max: sorted[sorted.length - 1] ?? 0,
		top_span_names: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, OVERSIZED_TOP_SPAN_NAMES),
		error_span_count: spans.filter((span) => span.status.code === "STATUS_CODE_ERROR").length,
		recommendation:
			"This trace exceeds the per-call view budget. Do not retry view_trace. Use halo_search_trace(trace_id, pattern), then halo_view_spans(trace_id, span_ids) for surgical reads.",
	};
}

async function readSlice(file: FileHandle, offset: number, length: number): Promise<string> {
	const buffer = Buffer.alloc(length);
	await file.read(buffer, 0, length, offset);
	return buffer.toString("utf8");
}
