export interface HaloSpanStatus {
	code: string;
	message?: string;
}

export interface HaloSpanResource {
	attributes: Record<string, unknown>;
}

export interface HaloSpanScope {
	name: string;
	version?: string;
}

export interface HaloSpanRecord {
	trace_id: string;
	span_id: string;
	parent_span_id?: string;
	trace_state?: string;
	name: string;
	kind: string;
	start_time: string;
	end_time: string;
	status: HaloSpanStatus;
	resource: HaloSpanResource;
	scope: HaloSpanScope;
	attributes: Record<string, unknown>;
}

export interface HaloTraceFilters {
	has_errors?: boolean;
	model_names?: string[];
	service_names?: string[];
	agent_names?: string[];
	project_id?: string;
	start_time_gte?: string;
	end_time_lte?: string;
}

export interface HaloTraceIndexRow {
	trace_id: string;
	byte_offsets: number[];
	byte_lengths: number[];
	span_count: number;
	start_time: string;
	end_time: string;
	has_errors: boolean;
	service_names: string[];
	model_names: string[];
	total_input_tokens: number;
	total_output_tokens: number;
	project_id?: string;
	agent_names: string[];
	error_span_count?: number;
	tool_error_count?: number;
	llm_error_count?: number;
	agent_error_count?: number;
	final_answer_present?: boolean;
	completed?: boolean;
	cancelled?: boolean;
}

export interface HaloTraceIndexMeta {
	schema_version: number;
	trace_count: number;
	source_size: number;
	source_mtime_ms: number;
	span_count?: number;
	corrupt_span_count?: number;
	corrupt_span_bytes?: number;
	first_corrupt_line?: number;
	build_started_at_ms?: number;
	build_finished_at_ms?: number;
}

export interface HaloTraceSummary {
	trace_id: string;
	span_count: number;
	start_time: string;
	end_time: string;
	has_errors: boolean;
	service_names: string[];
	model_names: string[];
	total_input_tokens: number;
	total_output_tokens: number;
	agent_names: string[];
	error_span_count?: number;
	tool_error_count?: number;
	llm_error_count?: number;
	agent_error_count?: number;
	final_answer_present?: boolean;
	completed?: boolean;
	cancelled?: boolean;
}

export interface HaloTraceQueryResult {
	traces: HaloTraceSummary[];
	total: number;
}

export interface HaloTraceCountResult {
	total: number;
}

export interface HaloDatasetOverview {
	total_traces: number;
	total_spans: number;
	earliest_start_time: string;
	latest_end_time: string;
	service_names: string[];
	model_names: string[];
	agent_names: string[];
	error_trace_count: number;
	total_input_tokens: number;
	total_output_tokens: number;
	sample_trace_ids: string[];
	error_breakdown?: {
		error_spans: number;
		tool_error_spans: number;
		llm_error_spans: number;
		agent_error_spans: number;
		completed_traces: number;
		cancelled_traces: number;
		traces_with_final_answer: number;
	};
	index_health?: {
		corrupt_span_count: number;
		corrupt_span_bytes: number;
		first_corrupt_line?: number;
	};
}

export interface HaloOversizedTraceSummary {
	trace_id: string;
	span_count: number;
	total_serialized_chars: number;
	char_budget: number;
	span_size_min: number;
	span_size_median: number;
	span_size_max: number;
	top_span_names: Array<[string, number]>;
	error_span_count: number;
	recommendation: string;
}

export interface HaloTraceView {
	trace_id: string;
	spans: HaloSpanRecord[];
	oversized?: HaloOversizedTraceSummary;
}

export interface HaloTraceSearchResult {
	trace_id: string;
	match_count: number;
	matches: string[];
}
