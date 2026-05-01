import { randomUUID } from "node:crypto";
import { open, rename, rm, stat, writeFile } from "node:fs/promises";
import type { HaloSpanRecord, HaloTraceIndexMeta, HaloTraceIndexRow } from "./types.js";

const INDEX_SCHEMA_VERSION = 1;
const INDEX_BUILD_RETRIES = 2;
const ATOMIC_RENAME_RETRIES = 5;

const activeIndexBuilds = new Map<string, Promise<void>>();

interface RowAccumulator {
	trace_id: string;
	byte_offsets: number[];
	byte_lengths: number[];
	span_count: number;
	start_time: string;
	end_time: string;
	has_errors: boolean;
	service_names: Set<string>;
	model_names: Set<string>;
	agent_names: Set<string>;
	total_input_tokens: number;
	total_output_tokens: number;
	project_id?: string;
	error_span_count: number;
	tool_error_count: number;
	llm_error_count: number;
	agent_error_count: number;
	final_answer_present: boolean;
	completed: boolean;
	cancelled: boolean;
}

interface ScanResult {
	rows: HaloTraceIndexRow[];
	spanCount: number;
	corruptSpanCount: number;
	corruptSpanBytes: number;
	firstCorruptLine?: number;
}

export function haloIndexPathFor(tracePath: string): string {
	return `${tracePath}.engine-index.jsonl`;
}

export function haloIndexMetaPathFor(indexPath: string): string {
	return indexPath.endsWith(".jsonl") ? `${indexPath.slice(0, -".jsonl".length)}.meta.json` : `${indexPath}.meta.json`;
}

export async function ensureHaloTraceIndex(
	tracePath: string,
	indexPath = haloIndexPathFor(tracePath),
): Promise<string> {
	const metaPath = haloIndexMetaPathFor(indexPath);
	const source = await stat(tracePath);

	try {
		const existing = await loadHaloTraceIndexMeta(metaPath);
		if (
			existing.schema_version === INDEX_SCHEMA_VERSION &&
			existing.source_size === source.size &&
			existing.source_mtime_ms === source.mtimeMs
		) {
			const rows = await loadHaloTraceIndex(indexPath);
			if (rows.length === existing.trace_count && new Set(rows.map((row) => row.trace_id)).size === rows.length) {
				return indexPath;
			}
		}
	} catch {
		// Missing or corrupt sidecar: rebuild below.
	}

	await buildHaloTraceIndex(tracePath, indexPath, metaPath, source.size, source.mtimeMs);
	return indexPath;
}

export async function buildHaloTraceIndex(
	tracePath: string,
	indexPath = haloIndexPathFor(tracePath),
	metaPath = haloIndexMetaPathFor(indexPath),
	sourceSize?: number,
	sourceMtimeMs?: number,
): Promise<void> {
	return singleflightIndexBuild(indexPath, () =>
		buildHaloTraceIndexUnsafe(tracePath, indexPath, metaPath, sourceSize, sourceMtimeMs),
	);
}

async function buildHaloTraceIndexUnsafe(
	tracePath: string,
	indexPath: string,
	metaPath: string,
	sourceSize?: number,
	sourceMtimeMs?: number,
): Promise<void> {
	for (let attempt = 0; attempt <= INDEX_BUILD_RETRIES; attempt++) {
		const startedAt = Date.now();
		const before =
			sourceSize === undefined || sourceMtimeMs === undefined || attempt > 0 ? await stat(tracePath) : undefined;
		const expectedSize = before?.size ?? sourceSize ?? 0;
		const expectedMtimeMs = before?.mtimeMs ?? sourceMtimeMs ?? 0;
		const scan = await scanTraceRows(tracePath);
		const after = await stat(tracePath);
		const sourceChanged = after.size !== expectedSize || after.mtimeMs !== expectedMtimeMs;
		if (sourceChanged && attempt < INDEX_BUILD_RETRIES) continue;
		await writeJsonlAtomic(
			indexPath,
			scan.rows.map((row) => JSON.stringify(row)).join("\n") + (scan.rows.length > 0 ? "\n" : ""),
		);
		const meta: HaloTraceIndexMeta = {
			schema_version: INDEX_SCHEMA_VERSION,
			trace_count: scan.rows.length,
			span_count: scan.spanCount,
			source_size: sourceChanged ? expectedSize : after.size,
			source_mtime_ms: sourceChanged ? expectedMtimeMs : after.mtimeMs,
			corrupt_span_count: scan.corruptSpanCount,
			corrupt_span_bytes: scan.corruptSpanBytes,
			...(scan.firstCorruptLine !== undefined ? { first_corrupt_line: scan.firstCorruptLine } : {}),
			build_started_at_ms: startedAt,
			build_finished_at_ms: Date.now(),
		};
		await writeTextAtomic(metaPath, JSON.stringify(meta));
		return;
	}
}

function singleflightIndexBuild(indexPath: string, build: () => Promise<void>): Promise<void> {
	const existing = activeIndexBuilds.get(indexPath);
	if (existing) return existing;
	const promise = build().finally(() => {
		activeIndexBuilds.delete(indexPath);
	});
	activeIndexBuilds.set(indexPath, promise);
	return promise;
}

export async function loadHaloTraceIndex(indexPath: string): Promise<HaloTraceIndexRow[]> {
	const text = await readUtf8(indexPath);
	const rows: HaloTraceIndexRow[] = [];
	const seen = new Set<string>();
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		let row: HaloTraceIndexRow;
		try {
			row = JSON.parse(line) as HaloTraceIndexRow;
		} catch {
			continue;
		}
		if (!isValidIndexRow(row) || seen.has(row.trace_id)) continue;
		seen.add(row.trace_id);
		rows.push(row);
	}
	return rows;
}

export async function loadHaloTraceIndexMeta(metaPath: string): Promise<HaloTraceIndexMeta> {
	return JSON.parse(await readUtf8(metaPath)) as HaloTraceIndexMeta;
}

async function scanTraceRows(tracePath: string): Promise<ScanResult> {
	const file = await open(tracePath, "r");
	try {
		const rows = new Map<string, RowAccumulator>();
		let offset = 0;
		let lineNumber = 0;
		let spanCount = 0;
		let corruptSpanCount = 0;
		let corruptSpanBytes = 0;
		let firstCorruptLine: number | undefined;
		for await (const line of file.readLines({ encoding: "utf8" })) {
			lineNumber++;
			const rawLength = Buffer.byteLength(line, "utf8");
			const newlineLength = 1;
			if (line.trim().length > 0) {
				try {
					const span = JSON.parse(line) as HaloSpanRecord;
					if (!span || typeof span.trace_id !== "string" || span.trace_id.length === 0) {
						throw new Error("invalid HALO span row");
					}
					const acc = rows.get(span.trace_id) ?? createAccumulator(span.trace_id);
					rows.set(span.trace_id, acc);
					absorbSpan(acc, span, offset, rawLength);
					spanCount++;
				} catch {
					corruptSpanCount++;
					corruptSpanBytes += rawLength;
					firstCorruptLine ??= lineNumber;
				}
			}
			offset += rawLength + newlineLength;
		}
		return {
			rows: [...rows.values()].map(finalizeAccumulator),
			spanCount,
			corruptSpanCount,
			corruptSpanBytes,
			firstCorruptLine,
		};
	} finally {
		await file.close();
	}
}

function createAccumulator(traceId: string): RowAccumulator {
	return {
		trace_id: traceId,
		byte_offsets: [],
		byte_lengths: [],
		span_count: 0,
		start_time: "",
		end_time: "",
		has_errors: false,
		service_names: new Set(),
		model_names: new Set(),
		agent_names: new Set(),
		total_input_tokens: 0,
		total_output_tokens: 0,
		error_span_count: 0,
		tool_error_count: 0,
		llm_error_count: 0,
		agent_error_count: 0,
		final_answer_present: false,
		completed: false,
		cancelled: false,
	};
}

function absorbSpan(acc: RowAccumulator, span: HaloSpanRecord, byteOffset: number, byteLength: number): void {
	acc.byte_offsets.push(byteOffset);
	acc.byte_lengths.push(byteLength);
	acc.span_count++;
	if (!acc.start_time || span.start_time < acc.start_time) acc.start_time = span.start_time;
	if (!acc.end_time || span.end_time > acc.end_time) acc.end_time = span.end_time;
	const observationKind = span.attributes["inference.observation_kind"];
	const isError = span.status.code === "STATUS_CODE_ERROR";
	if (isError) {
		acc.has_errors = true;
		acc.error_span_count++;
		if (observationKind === "TOOL") acc.tool_error_count++;
		else if (observationKind === "LLM") acc.llm_error_count++;
		else if (observationKind === "AGENT") acc.agent_error_count++;
	}
	const statusMessage = span.status.message ?? "";
	if (/shut down before|aborted|cancelled/i.test(statusMessage)) acc.cancelled = true;
	if (observationKind === "AGENT" && span.status.code === "STATUS_CODE_OK") acc.completed = true;
	if (observationKind === "LLM" && span.status.code === "STATUS_CODE_OK" && hasFinalAssistantText(span)) {
		acc.final_answer_present = true;
	}

	const service = span.resource.attributes["service.name"];
	if (typeof service === "string") acc.service_names.add(service);
	const model = span.attributes["inference.llm.model_name"] ?? span.attributes["llm.model_name"];
	if (typeof model === "string" && model.length > 0) acc.model_names.add(model);
	const agent = span.attributes["inference.agent_name"];
	if (typeof agent === "string" && agent.length > 0) acc.agent_names.add(agent);
	const inputTokens = span.attributes["inference.llm.input_tokens"];
	if (typeof inputTokens === "number") acc.total_input_tokens += inputTokens;
	const outputTokens = span.attributes["inference.llm.output_tokens"];
	if (typeof outputTokens === "number") acc.total_output_tokens += outputTokens;
	const projectId = span.attributes["inference.project_id"];
	if (typeof projectId === "string" && acc.project_id === undefined) acc.project_id = projectId;
}

function finalizeAccumulator(acc: RowAccumulator): HaloTraceIndexRow {
	return {
		trace_id: acc.trace_id,
		byte_offsets: acc.byte_offsets,
		byte_lengths: acc.byte_lengths,
		span_count: acc.span_count,
		start_time: acc.start_time,
		end_time: acc.end_time,
		has_errors: acc.has_errors,
		service_names: [...acc.service_names].sort(),
		model_names: [...acc.model_names].sort(),
		total_input_tokens: acc.total_input_tokens,
		total_output_tokens: acc.total_output_tokens,
		project_id: acc.project_id,
		agent_names: [...acc.agent_names].sort(),
		error_span_count: acc.error_span_count,
		tool_error_count: acc.tool_error_count,
		llm_error_count: acc.llm_error_count,
		agent_error_count: acc.agent_error_count,
		final_answer_present: acc.final_answer_present,
		completed: acc.completed,
		cancelled: acc.cancelled,
	};
}

function hasFinalAssistantText(span: HaloSpanRecord): boolean {
	const output = span.attributes["output.value"];
	if (typeof output === "string" && output.trim().length > 0) {
		const toolCalls = span.attributes["llm.tool_calls"];
		return !Array.isArray(toolCalls) || toolCalls.length === 0;
	}
	const messages = span.attributes["llm.output_messages"];
	if (!messages || typeof messages !== "object") return false;
	const content = (messages as { content?: unknown }).content;
	return (
		Array.isArray(content) &&
		content.some(
			(part) =>
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string" &&
				((part as { text: string }).text.trim().length > 0),
		)
	);
}

function isValidIndexRow(row: unknown): row is HaloTraceIndexRow {
	if (!row || typeof row !== "object") return false;
	const candidate = row as Partial<HaloTraceIndexRow>;
	return (
		typeof candidate.trace_id === "string" &&
		Array.isArray(candidate.byte_offsets) &&
		Array.isArray(candidate.byte_lengths) &&
		typeof candidate.span_count === "number" &&
		typeof candidate.start_time === "string" &&
		typeof candidate.end_time === "string" &&
		typeof candidate.has_errors === "boolean" &&
		Array.isArray(candidate.service_names) &&
		Array.isArray(candidate.model_names) &&
		Array.isArray(candidate.agent_names)
	);
}

async function readUtf8(path: string): Promise<string> {
	const fh = await open(path, "r");
	try {
		return await fh.readFile("utf8");
	} finally {
		await fh.close();
	}
}

async function writeJsonlAtomic(path: string, content: string): Promise<void> {
	await writeTextAtomic(path, content);
}

async function writeTextAtomic(path: string, content: string): Promise<void> {
	const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
	try {
		await writeFile(tmpPath, content, "utf8");
		for (let attempt = 0; attempt < ATOMIC_RENAME_RETRIES; attempt++) {
			try {
				await rename(tmpPath, path);
				return;
			} catch (error) {
				if (attempt === ATOMIC_RENAME_RETRIES - 1) throw error;
				await sleep(25 * (attempt + 1));
			}
		}
	} finally {
		await rm(tmpPath, { force: true }).catch(() => undefined);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
