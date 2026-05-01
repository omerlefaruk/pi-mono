import { existsSync } from "node:fs";
import { type Static, Type } from "typebox";
import type { ExtensionAPI } from "../extensions/index.js";
import { HaloTraceStore } from "./trace-store.js";
import { summarizeHaloToolOutput } from "./trace-writer.js";
import type { HaloTraceFilters } from "./types.js";

const TraceFiltersSchema = Type.Object({
	has_errors: Type.Optional(Type.Boolean()),
	model_names: Type.Optional(Type.Array(Type.String())),
	service_names: Type.Optional(Type.Array(Type.String())),
	agent_names: Type.Optional(Type.Array(Type.String())),
	project_id: Type.Optional(Type.String()),
	start_time_gte: Type.Optional(Type.String()),
	end_time_lte: Type.Optional(Type.String()),
});

const DatasetOverviewSchema = Type.Object({ filters: Type.Optional(TraceFiltersSchema) });
const QueryTracesSchema = Type.Object({
	filters: Type.Optional(TraceFiltersSchema),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
	offset: Type.Optional(Type.Number({ minimum: 0 })),
});
const CountTracesSchema = Type.Object({ filters: Type.Optional(TraceFiltersSchema) });
const ViewTraceSchema = Type.Object({ trace_id: Type.String() });
const ViewSpansSchema = Type.Object({
	trace_id: Type.String(),
	span_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 200 }),
});
const SearchTraceSchema = Type.Object({ trace_id: Type.String(), pattern: Type.String() });

export interface RegisterHaloTraceToolsOptions {
	tracePath: string;
}

type DatasetOverviewInput = Static<typeof DatasetOverviewSchema>;
type QueryTracesInput = Static<typeof QueryTracesSchema>;
type CountTracesInput = Static<typeof CountTracesSchema>;
type ViewTraceInput = Static<typeof ViewTraceSchema>;
type ViewSpansInput = Static<typeof ViewSpansSchema>;
type SearchTraceInput = Static<typeof SearchTraceSchema>;

function haloToolResult(toolName: string, result: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
		details: { summary: summarizeHaloToolOutput(toolName, { details: { result } }) },
	};
}

export function registerHaloTraceTools(pi: ExtensionAPI, options: RegisterHaloTraceToolsOptions): void {
	const getStore = async () => {
		if (!existsSync(options.tracePath)) throw new Error(`HALO trace file does not exist yet: ${options.tracePath}`);
		return HaloTraceStore.load(options.tracePath);
	};

	pi.registerTool({
		name: "halo_get_dataset_overview",
		label: "HALO Overview",
		description:
			"Return high-level stats about the local HALO/pi trace dataset: trace counts, spans, services, models, token totals, errors, and sample trace ids.",
		promptSnippet: "Inspect aggregate local pi/HALO trace telemetry before diagnosing harness failures",
		promptGuidelines: [
			"Use halo_get_dataset_overview before other halo_* trace tools when diagnosing repeated harness behavior from actual traces.",
		],
		parameters: DatasetOverviewSchema,
		async execute(_toolCallId, params: DatasetOverviewInput) {
			const result = (await getStore()).getOverview(toFilters(params.filters));
			return haloToolResult("halo_get_dataset_overview", result);
		},
	});

	pi.registerTool({
		name: "halo_query_traces",
		label: "HALO Query Traces",
		description:
			"List trace summaries matching filters with pagination. Use this to find real trace ids before viewing spans.",
		promptSnippet: "List local pi/HALO trace summaries by filters",
		parameters: QueryTracesSchema,
		async execute(_toolCallId, params: QueryTracesInput) {
			const result = (await getStore()).queryTraces(
				toFilters(params.filters),
				params.limit ?? 50,
				params.offset ?? 0,
			);
			return haloToolResult("halo_query_traces", result);
		},
	});

	pi.registerTool({
		name: "halo_count_traces",
		label: "HALO Count Traces",
		description: "Count traces matching filters without materializing summaries.",
		promptSnippet: "Count local pi/HALO traces by filters",
		parameters: CountTracesSchema,
		async execute(_toolCallId, params: CountTracesInput) {
			const result = (await getStore()).countTraces(toFilters(params.filters));
			return haloToolResult("halo_count_traces", result);
		},
	});

	pi.registerTool({
		name: "halo_view_trace",
		label: "HALO View Trace",
		description:
			"Return all spans of a local pi/HALO trace by id. Large attributes are head-capped; oversized traces return an oversized summary and should be explored with halo_search_trace plus halo_view_spans.",
		promptSnippet: "View spans for one local pi/HALO trace id",
		parameters: ViewTraceSchema,
		async execute(_toolCallId, params: ViewTraceInput) {
			const result = await (await getStore()).viewTrace(params.trace_id);
			return haloToolResult("halo_view_trace", result);
		},
	});

	pi.registerTool({
		name: "halo_view_spans",
		label: "HALO View Spans",
		description:
			"Return selected spans from a local pi/HALO trace at a higher per-attribute cap than halo_view_trace and halo_search_trace. Use after search hits identify span ids.",
		promptSnippet: "Read selected pi/HALO trace spans by id",
		parameters: ViewSpansSchema,
		async execute(_toolCallId, params: ViewSpansInput) {
			const result = await (await getStore()).viewSpans(params.trace_id, [...params.span_ids]);
			return haloToolResult("halo_view_spans", result);
		},
	});

	pi.registerTool({
		name: "halo_search_trace",
		label: "HALO Search Trace",
		description:
			"Substring-search one local pi/HALO trace. Pattern matches raw JSON, including status strings, tool names, error text, and attribute keys. Follow up with halo_view_spans for more of matched spans.",
		promptSnippet: "Search within one pi/HALO trace for errors, tools, models, or text",
		parameters: SearchTraceSchema,
		async execute(_toolCallId, params: SearchTraceInput) {
			const result = await (await getStore()).searchTrace(params.trace_id, params.pattern);
			return haloToolResult("halo_search_trace", result);
		},
	});
}

function toFilters(filters: Static<typeof TraceFiltersSchema> | undefined): HaloTraceFilters {
	return filters ?? {};
}
