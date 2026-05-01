import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { createSpanId, createTraceId, toOtelTime } from "./ids.js";
import type { HaloSpanRecord } from "./types.js";

export interface HaloTraceWriterOptions {
	tracePath: string;
	projectId?: string;
	serviceName?: string;
	serviceVersion?: string;
	deploymentEnvironment?: string;
}

export interface HaloActiveSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: string;
	observationKind: string;
	startTime: number;
	attributes: Record<string, unknown>;
}

export class HaloTraceWriter {
	readonly tracePath: string;
	readonly projectId: string;
	readonly serviceName: string;
	readonly serviceVersion?: string;
	readonly deploymentEnvironment?: string;
	private appendQueue: Promise<void> = Promise.resolve();

	constructor(options: HaloTraceWriterOptions) {
		this.tracePath = options.tracePath;
		this.projectId = options.projectId ?? "pi";
		this.serviceName = options.serviceName ?? "pi-coding-agent";
		this.serviceVersion = options.serviceVersion;
		this.deploymentEnvironment = options.deploymentEnvironment;
	}

	startSpan(input: {
		traceId?: string;
		parentSpanId?: string;
		name: string;
		kind?: string;
		observationKind: string;
		attributes?: Record<string, unknown>;
		startTime?: number;
	}): HaloActiveSpan {
		return {
			traceId: input.traceId ?? createTraceId(),
			spanId: createSpanId(),
			parentSpanId: input.parentSpanId,
			name: input.name,
			kind: input.kind ?? "SPAN_KIND_INTERNAL",
			observationKind: input.observationKind,
			startTime: input.startTime ?? Date.now(),
			attributes: input.attributes ?? {},
		};
	}

	async endSpan(
		span: HaloActiveSpan,
		input: {
			statusCode?: string;
			statusMessage?: string;
			attributes?: Record<string, unknown>;
			endTime?: number;
		} = {},
	): Promise<HaloSpanRecord> {
		const record = this.toRecord(span, input);
		await this.append(record);
		return record;
	}

	toRecord(
		span: HaloActiveSpan,
		input: {
			statusCode?: string;
			statusMessage?: string;
			attributes?: Record<string, unknown>;
			endTime?: number;
		} = {},
	): HaloSpanRecord {
		return {
			trace_id: span.traceId,
			span_id: span.spanId,
			parent_span_id: span.parentSpanId ?? "",
			trace_state: "",
			name: span.name,
			kind: span.kind,
			start_time: toOtelTime(span.startTime),
			end_time: toOtelTime(input.endTime ?? Date.now()),
			status: {
				code: input.statusCode ?? "STATUS_CODE_OK",
				message: input.statusMessage ?? "",
			},
			resource: {
				attributes: {
					"service.name": this.serviceName,
					...(this.serviceVersion ? { "service.version": this.serviceVersion } : {}),
					...(this.deploymentEnvironment ? { "deployment.environment": this.deploymentEnvironment } : {}),
				},
			},
			scope: { name: "pi-coding-agent-halo", version: "1" },
			attributes: {
				"inference.export.schema_version": 1,
				"inference.project_id": this.projectId,
				"inference.observation_kind": span.observationKind,
				...span.attributes,
				...(input.attributes ?? {}),
			},
		};
	}

	async append(record: HaloSpanRecord): Promise<void> {
		const sanitized = sanitizeSpanRecord(record);
		const write = async () => {
			await mkdir(dirname(this.tracePath), { recursive: true });
			const file = await open(this.tracePath, "a");
			try {
				await file.appendFile(`${JSON.stringify(sanitized)}\n`, "utf8");
			} finally {
				await file.close();
			}
		};
		const result = this.appendQueue.then(write, write);
		this.appendQueue = result.catch(() => undefined);
		await result;
	}
}

export function agentMessageText(message: AgentMessage): string {
	if (message.role === "user") {
		return typeof message.content === "string" ? message.content : JSON.stringify(summarizeContent(message.content));
	}
	if (message.role === "assistant") {
		return message.content
			.map((part) => {
				if (part.type === "text") return part.text;
				if (part.type === "thinking") return part.thinking;
				if (part.type === "toolCall") return `${part.name}(${safeJson(part.arguments) ?? ""})`;
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	if (message.role === "toolResult") return JSON.stringify(summarizeContent(message.content));
	if (message.role === "bashExecution") return message.output;
	if (message.role === "custom") {
		return typeof message.content === "string" ? message.content : JSON.stringify(summarizeContent(message.content));
	}
	if (message.role === "branchSummary") return message.summary;
	if (message.role === "compactionSummary") return message.summary;
	return "";
}

export function agentMessageToolCalls(message: AgentMessage): Array<{ id: string; name: string; arguments: unknown }> {
	if (message.role !== "assistant") return [];
	return message.content
		.filter((part): part is ToolCall => part.type === "toolCall")
		.map((part) => ({ id: part.id, name: part.name, arguments: part.arguments }));
}

export function summarizeAgentMessage(message: AgentMessage): Record<string, unknown> {
	if (message.role === "assistant") {
		return {
			role: message.role,
			api: message.api,
			provider: message.provider,
			model: message.model,
			stopReason: message.stopReason,
			errorMessage: redactTraceText(message.errorMessage),
			timestamp: message.timestamp,
			usage: message.usage,
			content: message.content.map((part) => {
				if (part.type === "text") return { type: "text", text: redactTraceText(part.text, 4096) };
				if (part.type === "thinking") return { type: "thinking", thinking: redactTraceText(part.thinking, 512) };
				return {
					type: "toolCall",
					id: part.id,
					name: part.name,
					arguments: truncateUnknown(part.arguments, 4096),
				};
			}),
		};
	}
	return {
		role: message.role,
		timestamp: "timestamp" in message ? message.timestamp : undefined,
		content: redactTraceText(agentMessageText(message), 4096),
	};
}

export function summarizeToolResult(result: ToolResultMessage): Record<string, unknown> {
	if (result.toolName.startsWith("halo_")) {
		return {
			toolCallId: result.toolCallId,
			toolName: result.toolName,
			isError: result.isError,
			content: summarizeHaloToolResultContent(result),
			details: summarizeHaloToolOutput(result.toolName, { details: result.details }),
		};
	}
	return {
		toolCallId: result.toolCallId,
		toolName: result.toolName,
		isError: result.isError,
		content: summarizeContent(result.content),
		details: truncateUnknown(result.details, 4096),
	};
}

function summarizeHaloToolResultContent(result: ToolResultMessage): Record<string, unknown> {
	if (typeof result.content === "string") {
		return {
			type: "halo_compact_content",
			text_part_count: 1,
			image_part_count: 0,
			text_bytes: Buffer.byteLength(result.content, "utf8"),
			message: "HALO tool content omitted from trace; use the original tool result or halo_view_spans for details.",
		};
	}
	const textParts = result.content.filter((part) => part.type === "text");
	const imageParts = result.content.filter((part) => part.type === "image");
	const textBytes = textParts.reduce((total, part) => total + Buffer.byteLength(part.text, "utf8"), 0);
	return {
		type: "halo_compact_content",
		text_part_count: textParts.length,
		image_part_count: imageParts.length,
		text_bytes: textBytes,
		message: "HALO tool content omitted from trace; use the original tool result or halo_view_spans for details.",
	};
}

export function summarizeAgentRunOutput(messages: AgentMessage[], cap = 16_384): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") {
			const summary = summarizeToolResult(message as ToolResultMessage);
			parts.push(
				`[toolResult ${message.toolName} error=${message.isError} ${safeJson(summary)?.slice(0, 2048) ?? ""}]`,
			);
			continue;
		}
		const text = agentMessageText(message);
		if (text) parts.push(redactTraceText(text, 4096));
	}
	return truncateString(parts.join("\n\n"), cap);
}

export function summarizeContent(content: string | Array<TextContent | ImageContent>): unknown {
	if (typeof content === "string") return redactTraceText(content, 4096);
	return content.map((part) => {
		if (part.type === "text") return { type: "text", text: redactTraceText(part.text, 4096) };
		return { type: "image", mimeType: part.mimeType, data: `[base64 omitted: ${part.data.length} chars]` };
	});
}

export function truncateUnknown(value: unknown, cap: number): unknown {
	if (typeof value === "string") return redactTraceText(value, cap);
	const json = safeJson(value);
	if (json === undefined || json.length <= cap) return value;
	return `${redactTraceText(json.slice(0, cap), cap)}... [truncated: original ${json.length} chars]`;
}

export function summarizeHaloToolOutput(toolName: string, result: unknown): Record<string, unknown> | unknown {
	if (!toolName.startsWith("halo_")) return truncateUnknown(result, 16_384);
	const details =
		result && typeof result === "object"
			? (result as { details?: { result?: unknown; summary?: Record<string, unknown> } }).details
			: undefined;
	if (details?.summary) return details.summary;
	const payload = details?.result;
	if (!payload || typeof payload !== "object") {
		return { haloTool: toolName, resultBytes: safeJson(result)?.length ?? 0 };
	}
	const obj = payload as Record<string, unknown>;
	const spans = Array.isArray(obj.spans) ? obj.spans : undefined;
	const traces = Array.isArray(obj.traces) ? obj.traces : undefined;
	const matches = Array.isArray(obj.matches) ? obj.matches : undefined;
	return {
		haloTool: toolName,
		trace_id: obj.trace_id,
		total: obj.total,
		total_traces: obj.total_traces,
		total_spans: obj.total_spans,
		error_trace_count: obj.error_trace_count,
		span_count: spans?.length,
		trace_count: traces?.length,
		match_count: obj.match_count ?? matches?.length,
		oversized: obj.oversized,
		resultBytes: safeJson(payload)?.length ?? 0,
	};
}

function sanitizeSpanRecord(record: HaloSpanRecord): HaloSpanRecord {
	const attributes: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record.attributes)) {
		attributes[key] = truncateUnknown(value, key.startsWith("llm.") || key === "output.value" ? 4096 : 16_384);
	}
	return { ...record, attributes };
}

function redactTraceText(value: string | undefined, cap = 4096): string {
	if (!value) return "";
	const redacted = value
		.replace(/([A-Z0-9_]*(?:API|TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*=)[^\s]+/gi, "$1[REDACTED]")
		.replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[REDACTED_API_KEY]")
		.replace(/([A-Za-z0-9+/]{4096,}={0,2})/g, "[large-base64-like-data omitted]");
	return truncateString(redacted, cap);
}

function truncateString(value: string, cap: number): string {
	return value.length > cap ? `${value.slice(0, cap)}... [truncated: original ${value.length} chars]` : value;
}

function safeJson(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}
