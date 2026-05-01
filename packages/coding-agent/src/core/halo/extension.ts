import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { getAgentDir, VERSION } from "../../config.js";
import type { ExtensionAPI, ExtensionContext } from "../extensions/index.js";
import { registerHaloTraceTools } from "./tools.js";
import {
	agentMessageText,
	agentMessageToolCalls,
	HaloTraceWriter,
	summarizeAgentMessage,
	summarizeAgentRunOutput,
	summarizeHaloToolOutput,
	summarizeToolResult,
	truncateUnknown,
} from "./trace-writer.js";

export interface HaloExtensionOptions {
	tracePath?: string;
	projectId?: string;
	serviceName?: string;
	serviceVersion?: string;
	deploymentEnvironment?: string;
	registerTools?: boolean;
}

interface ActiveRun {
	agent: ReturnType<HaloTraceWriter["startSpan"]>;
	errorMessage?: string;
}

interface HaloActiveContextEvent {
	traceId: string;
	rootSpanId: string;
	spanId: string;
	kind: "agent" | "turn" | "tool";
	toolName?: string;
	toolCallId?: string;
}

export function defaultHaloTracePath(): string {
	return (
		process.env.PI_HALO_TRACES_PATH ?? process.env.HALO_TRACES_PATH ?? join(getAgentDir(), "halo", "traces.jsonl")
	);
}

export function createHaloExtension(options: HaloExtensionOptions = {}) {
	return function haloExtension(pi: ExtensionAPI): void {
		const tracePath = options.tracePath ?? defaultHaloTracePath();
		const writer = new HaloTraceWriter({
			tracePath,
			projectId: options.projectId ?? process.env.PI_HALO_PROJECT_ID ?? "pi",
			serviceName: options.serviceName ?? process.env.PI_HALO_SERVICE_NAME ?? "pi-coding-agent",
			serviceVersion: options.serviceVersion ?? VERSION,
			deploymentEnvironment: options.deploymentEnvironment ?? process.env.PI_HALO_ENVIRONMENT,
		});

		let pendingPrompt = "";
		let activeRun: ActiveRun | undefined;
		const activeTurns = new Map<number, ReturnType<HaloTraceWriter["startSpan"]>>();
		const activeTools = new Map<string, ReturnType<HaloTraceWriter["startSpan"]>>();
		const closedSpans = new Set<string>();
		const closingSpans = new Set<string>();
		const toolCounts = new Map<string, number>();
		const toolLoopWarnings = new Set<string>();

		const emitActiveContext = (event: HaloActiveContextEvent | null) => {
			pi.events.emit("halo:active_context", event);
		};

		if (options.registerTools ?? true) registerHaloTraceTools(pi, { tracePath });

		pi.on("input", async (event, ctx) => {
			const converted = parseMsysConvertedHaloCommand(event.text);
			if (!converted) return;
			if (converted.command === "halo-status") {
				showHaloStatus(ctx, tracePath);
				return { action: "handled" as const };
			}
			if (converted.command === "halo-analyze") {
				queueHaloAnalyze(pi, converted.args);
				return { action: "handled" as const };
			}
			if (converted.command === "halo-engine") {
				await runHaloEngine(pi, ctx, tracePath, converted.args);
				return { action: "handled" as const };
			}
		});

		pi.on("before_agent_start", (event, ctx) => {
			pendingPrompt = event.prompt;
			const promptHints = buildPromptWarnings(event.prompt, ctx);
			if (promptHints.length === 0) return;
			return { systemPrompt: `${event.systemPrompt}\n\nCurrent turn safety hints:\n- ${promptHints.join("\n- ")}` };
		});

		pi.on("agent_start", (_event, ctx) => {
			toolCounts.clear();
			toolLoopWarnings.clear();
			const model = ctx.model;
			activeRun = {
				agent: writer.startSpan({
					name: "agent.pi",
					observationKind: "AGENT",
					attributes: {
						"inference.agent_name": "pi",
						"input.value": pendingPrompt,
						"pi.cwd": ctx.cwd,
						"pi.session_file": ctx.sessionManager.getSessionFile(),
						"pi.session_id": ctx.sessionManager.getSessionId(),
						...(model ? modelAttributes(model.provider, model.id) : {}),
					},
				}),
			};
			emitActiveContext({
				traceId: activeRun.agent.traceId,
				rootSpanId: activeRun.agent.spanId,
				spanId: activeRun.agent.spanId,
				kind: "agent",
			});
		});

		pi.on("turn_start", (event, ctx) => {
			if (!activeRun) return;
			const model = ctx.model;
			const turnSpan = writer.startSpan({
				traceId: activeRun.agent.traceId,
				parentSpanId: activeRun.agent.spanId,
				name: model ? `response.${model.id}` : "response.unknown",
				observationKind: "LLM",
				startTime: event.timestamp,
				attributes: {
					"pi.turn_index": event.turnIndex,
					...(model ? modelAttributes(model.provider, model.id) : {}),
				},
			});
			activeTurns.set(event.turnIndex, turnSpan);
			emitActiveContext({
				traceId: turnSpan.traceId,
				rootSpanId: activeRun.agent.spanId,
				spanId: turnSpan.spanId,
				kind: "turn",
			});
		});

		pi.on("turn_end", async (event) => {
			const turn = activeTurns.get(event.turnIndex);
			if (!turn) return;
			activeTurns.delete(event.turnIndex);
			const message = event.message;
			const errorMessage = assistantErrorMessage(message);
			if (activeRun && errorMessage) activeRun.errorMessage = errorMessage;
			await endSpanOnce(writer, closedSpans, closingSpans, turn, {
				statusCode: assistantStopReason(message) === "error" ? "STATUS_CODE_ERROR" : "STATUS_CODE_OK",
				statusMessage: errorMessage,
				attributes: {
					"output.value": agentMessageText(message),
					"llm.output_messages": summarizeAgentMessage(message),
					"llm.tool_calls": agentMessageToolCalls(message),
					"pi.tool_result_count": event.toolResults.length,
					...usageAttributes(message),
				},
			});
		});

		pi.on("tool_execution_start", (event, ctx) => {
			if (!activeRun) return;
			const count = (toolCounts.get(event.toolName) ?? 0) + 1;
			toolCounts.set(event.toolName, count);
			const loopWarning = loopWarningForTool(event.toolName, count);
			if (loopWarning && !toolLoopWarnings.has(event.toolName)) {
				toolLoopWarnings.add(event.toolName);
				ctx.ui.notify(loopWarning, "warning");
			}
			const toolSpan = writer.startSpan({
				traceId: activeRun.agent.traceId,
				parentSpanId: activeRun.agent.spanId,
				name: `function.${event.toolName}`,
				observationKind: "TOOL",
				attributes: {
					"tool.name": event.toolName,
					"tool.call_id": event.toolCallId,
					"input.value": truncateUnknown(event.args, 16_384),
					"pi.tool_call_count_for_name": count,
					...(loopWarning ? { "pi.tool_loop_warning": loopWarning } : {}),
				},
			});
			activeTools.set(event.toolCallId, toolSpan);
			emitActiveContext({
				traceId: toolSpan.traceId,
				rootSpanId: activeRun.agent.spanId,
				spanId: toolSpan.spanId,
				kind: "tool",
				toolName: event.toolName,
				toolCallId: event.toolCallId,
			});
		});

		pi.on("tool_execution_end", async (event) => {
			const span = activeTools.get(event.toolCallId);
			if (!span) return;
			activeTools.delete(event.toolCallId);
			await endSpanOnce(writer, closedSpans, closingSpans, span, {
				statusCode: event.isError ? "STATUS_CODE_ERROR" : "STATUS_CODE_OK",
				statusMessage: event.isError ? toolResultText(event.result) : "",
				attributes: {
					"output.value": summarizeHaloToolOutput(event.toolName, event.result),
					"pi.tool_is_error": event.isError,
				},
			});
			if (activeRun) {
				emitActiveContext({
					traceId: activeRun.agent.traceId,
					rootSpanId: activeRun.agent.spanId,
					spanId: activeRun.agent.spanId,
					kind: "agent",
				});
			}
		});

		pi.on("agent_end", async (event) => {
			if (!activeRun) return;
			const run = activeRun;
			activeRun = undefined;
			const errorMessage = run.errorMessage;
			await endSpanOnce(writer, closedSpans, closingSpans, run.agent, {
				statusCode: errorMessage ? "STATUS_CODE_ERROR" : "STATUS_CODE_OK",
				statusMessage: errorMessage ?? "",
				attributes: {
					"output.value": summarizeAgentRunOutput(event.messages),
					"pi.message_count": event.messages.length,
				},
			});
			emitActiveContext(null);
		});

		pi.on("session_shutdown", async () => {
			emitActiveContext(null);
			for (const span of activeTools.values()) {
				await endSpanOnce(writer, closedSpans, closingSpans, span, {
					statusCode: "STATUS_CODE_ERROR",
					statusMessage: "Session shut down before tool completed",
				});
			}
			activeTools.clear();
			for (const span of activeTurns.values()) {
				await endSpanOnce(writer, closedSpans, closingSpans, span, {
					statusCode: "STATUS_CODE_ERROR",
					statusMessage: "Session shut down before turn completed",
				});
			}
			activeTurns.clear();
			if (activeRun) {
				const run = activeRun;
				activeRun = undefined;
				await endSpanOnce(writer, closedSpans, closingSpans, run.agent, {
					statusCode: run.errorMessage ? "STATUS_CODE_ERROR" : "STATUS_CODE_OK",
					statusMessage: run.errorMessage ?? "Session shut down without agent_end event",
				});
			}
		});

		pi.registerCommand("halo-status", {
			description: "Show HALO trace capture status and trace path",
			handler: async (_args, ctx) => {
				showHaloStatus(ctx, tracePath);
			},
		});

		pi.registerCommand("halo-analyze", {
			description: "Ask pi to diagnose harness behavior from local HALO traces",
			handler: async (args) => {
				queueHaloAnalyze(pi, args);
			},
		});

		pi.registerCommand("halo-engine", {
			description: "Run the external halo-engine CLI against local pi traces: /halo-engine <prompt>",
			handler: async (args, ctx) => {
				await runHaloEngine(pi, ctx, tracePath, args);
			},
		});
	};
}

function parseMsysConvertedHaloCommand(text: string): { command: string; args: string } | undefined {
	const match = text.match(
		/^C:[\\/]Program Files[\\/]Git[\\/](halo-status|halo-analyze|halo-engine)(?:\s+([\s\S]*))?$/,
	);
	if (!match?.[1]) return undefined;
	return { command: match[1], args: match[2] ?? "" };
}

function buildPromptWarnings(prompt: string, ctx: ExtensionContext): string[] {
	const promptHints: string[] = [];
	if (looksLikeBarePath(prompt)) {
		promptHints.push(
			"The user's input looks like a bare path. Inspect existence/type first; do not execute it unless the user explicitly asks to run it.",
		);
	}
	const contextUsage = ctx.getContextUsage();
	const isShortPrompt = prompt.length < 500;
	if (contextUsage && isShortPrompt) {
		if (contextUsage.percent !== null && contextUsage.percent >= 90) {
			promptHints.push(
				`Context is very full (${contextUsage.percent.toFixed(0)}%). Prefer /compact or a concise answer before more tool use.`,
			);
			ctx.ui.notify("Context is above 90%. Consider /compact before continuing.", "warning");
		} else if (
			(contextUsage.percent !== null && contextUsage.percent >= 70) ||
			(contextUsage.tokens !== null && contextUsage.tokens > 100_000)
		) {
			promptHints.push(
				"Context is high. Avoid broad exploration; use focused tools and summarize before continuing.",
			);
			ctx.ui.notify(
				`High context usage (${contextUsage.tokens?.toLocaleString() ?? "unknown"} tokens). Consider /compact before simple follow-up prompts.`,
				"warning",
			);
		}
	}
	if (ctx.hasPendingMessages() && isShortPrompt) {
		promptHints.push(
			"There are queued follow-up/steering messages. Avoid starting a new exploration loop; resolve the current task state first.",
		);
	}
	return promptHints;
}

function loopWarningForTool(toolName: string, count: number): string | undefined {
	if (toolName === "read" && count === 25)
		return "High read tool count in this run. Pause and summarize; use grep/find and offset/limit instead of re-reading files.";
	if ((toolName === "grep" || toolName === "find") && count === 10)
		return `High ${toolName} tool count in this run. Consolidate searches and read shortlisted files.`;
	return undefined;
}

function showHaloStatus(ctx: ExtensionContext, tracePath: string): void {
	const exists = existsSync(tracePath);
	ctx.ui.notify(`HALO traces: ${tracePath}${exists ? "" : " (not created yet)"}`, "info");
}

function queueHaloAnalyze(pi: ExtensionAPI, args: string): void {
	const focus =
		args.trim() ||
		"Find systemic pi harness failure modes, inefficient loops, tool misuse, and prompt/tooling changes likely to improve future runs.";
	pi.sendUserMessage(
		`Analyze actual local HALO traces using the halo_* trace tools. Start with halo_get_dataset_overview, inspect representative error and non-error traces, then propose concrete pi harness improvements. Focus: ${focus}`,
	);
}

async function runHaloEngine(pi: ExtensionAPI, ctx: ExtensionContext, tracePath: string, args: string): Promise<void> {
	const prompt = args.trim() || "Diagnose repeated pi harness failure modes and suggest concrete fixes.";
	ctx.ui.notify("Running halo-engine over local pi traces...", "info");
	try {
		const result = await pi.exec("halo", [tracePath, "-p", prompt], {
			signal: ctx.signal,
			timeout: 10 * 60 * 1000,
		});
		const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
		pi.sendMessage(
			{
				customType: "halo-engine",
				content: text || `halo exited with code ${result.code}`,
				display: true,
				details: { tracePath, code: result.code, killed: result.killed },
			},
			{ triggerTurn: false },
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`halo-engine failed: ${message}`, "error");
	}
}

async function endSpanOnce(
	writer: HaloTraceWriter,
	closedSpans: Set<string>,
	closingSpans: Set<string>,
	span: ReturnType<HaloTraceWriter["startSpan"]>,
	input: Parameters<HaloTraceWriter["endSpan"]>[1],
): Promise<void> {
	const key = `${span.traceId}:${span.spanId}`;
	if (closedSpans.has(key) || closingSpans.has(key)) return;
	closingSpans.add(key);
	try {
		await writer.endSpan(span, input);
		closedSpans.add(key);
	} finally {
		closingSpans.delete(key);
	}
}

function looksLikeBarePath(text: string): boolean {
	const trimmed = text.trim();
	if (/^([A-Za-z]:[\\/]|\/|~\/)[^\n]*$/.test(trimmed)) return true;
	return trimmed.length > 0 && !trimmed.includes("\n") && /^[.]{1,2}[\\/]/.test(trimmed);
}

function modelAttributes(provider: string, modelId: string): Record<string, unknown> {
	return {
		"llm.model_name": modelId,
		"inference.llm.model_name": modelId,
		"pi.model_provider": provider,
	};
}

function usageAttributes(message: AgentMessage): Record<string, unknown> {
	if (message.role !== "assistant") return {};
	return {
		"inference.llm.input_tokens": message.usage.input,
		"inference.llm.output_tokens": message.usage.output,
		"llm.token_count.prompt": message.usage.input,
		"llm.token_count.completion": message.usage.output,
		"pi.cost_total": message.usage.cost.total,
	};
}

function assistantStopReason(message: AgentMessage): string | undefined {
	return message.role === "assistant" ? message.stopReason : undefined;
}

function assistantErrorMessage(message: AgentMessage): string {
	return message.role === "assistant" ? (message.errorMessage ?? "") : "";
}

function toolResultText(result: unknown): string {
	if (!result || typeof result !== "object") return String(result ?? "");
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return JSON.stringify(truncateUnknown(result, 4096));
	return content
		.map((part) => {
			if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
				return (part as { text?: unknown }).text;
			}
			return "";
		})
		.filter((text): text is string => typeof text === "string" && text.length > 0)
		.join("\n");
}

export { summarizeToolResult };
