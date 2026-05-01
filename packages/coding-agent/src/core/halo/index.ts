export { createHaloExtension, defaultHaloTracePath, type HaloExtensionOptions } from "./extension.js";
export { createSpanId, createTraceId, toOtelTime } from "./ids.js";
export { type RegisterHaloTraceToolsOptions, registerHaloTraceTools } from "./tools.js";
export {
	buildHaloTraceIndex,
	ensureHaloTraceIndex,
	haloIndexMetaPathFor,
	haloIndexPathFor,
	loadHaloTraceIndex,
} from "./trace-index.js";
export { HaloTraceStore } from "./trace-store.js";
export {
	agentMessageText,
	agentMessageToolCalls,
	type HaloActiveSpan,
	HaloTraceWriter,
	type HaloTraceWriterOptions,
	summarizeAgentMessage,
	summarizeContent,
	summarizeHaloToolOutput,
	summarizeToolResult,
	truncateUnknown,
} from "./trace-writer.js";
export type {
	HaloDatasetOverview,
	HaloOversizedTraceSummary,
	HaloSpanRecord,
	HaloSpanResource,
	HaloSpanScope,
	HaloSpanStatus,
	HaloTraceCountResult,
	HaloTraceFilters,
	HaloTraceIndexMeta,
	HaloTraceIndexRow,
	HaloTraceQueryResult,
	HaloTraceSearchResult,
	HaloTraceSummary,
	HaloTraceView,
} from "./types.js";
