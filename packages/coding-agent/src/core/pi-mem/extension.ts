import { basename, join } from "node:path";
import { getAgentDir } from "../../config.js";
import { estimateContextTokens } from "../compaction/index.js";
import type { ExtensionAPI, ExtensionContext } from "../extensions/index.js";
import { defaultHaloTracePath } from "../halo/extension.js";
import { HaloTraceWriter } from "../halo/trace-writer.js";
import { extractMemoryCandidatesFromMessage, extractMemoryCandidatesFromToolResult } from "./extraction.js";
import { redactLikelySecrets } from "./redaction.js";
import { formatInjectedMemories } from "./retrieval.js";
import { PiMemStore } from "./store.js";
import { registerPiMemTools } from "./tools.js";
import type { PiMemCitation, PiMemRecord, PiMemRecordType, PiMemResolvedSettings, PiMemSettings } from "./types.js";

export interface PiMemExtensionOptions {
	cwd: string;
	agentDir?: string;
	settings?: PiMemSettings;
	updateSettings?: (settings: PiMemSettings) => void;
}

export function defaultPiMemPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "pi-mem", "memories.jsonl");
}

export function resolvePiMemSettings(settings: PiMemSettings | undefined): PiMemResolvedSettings {
	return {
		enabled: settings?.enabled ?? true,
		autoExtract: settings?.autoExtract ?? true,
		autoInject: settings?.autoInject ?? true,
		maxInjected: clampInteger(settings?.maxInjected, 1, 32, 8),
		maxQueryResults: clampInteger(settings?.maxQueryResults, 1, 100, 20),
		redactMode: settings?.redactMode ?? "mask",
		namespaces: settings?.namespaces ?? [],
		storePath: settings?.storePath,
		storageBackend: settings?.storageBackend ?? "jsonl",
		projectId: settings?.projectId,
		extractionMode: settings?.extractionMode ?? "heuristic",
		extractionModel: settings?.extractionModel,
	};
}

interface HaloActiveContext extends PiMemCitation {
	traceId: string;
	rootSpanId: string;
	spanId: string;
	kind: "agent" | "turn" | "tool";
}

const PI_MEM_MAX_INJECTED_TOKENS = 2048;
const PI_MEM_MIN_CONTEXT_RESERVE_TOKENS = 4096;
const PI_MEM_HIGH_CONTEXT_USAGE_PERCENT = 85;

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function selectInjectedMemoriesWithinBudget(memories: PiMemRecord[], tokenBudget: number): PiMemRecord[] {
	if (tokenBudget <= 0) return [];
	const selected: PiMemRecord[] = [];
	for (const memory of memories) {
		const candidate = [...selected, memory];
		if (estimateTextTokens(formatInjectedMemories(candidate)) > tokenBudget) continue;
		selected.push(memory);
	}
	return selected;
}

export function createPiMemExtension(options: PiMemExtensionOptions) {
	return function piMemExtension(pi: ExtensionAPI): void {
		let settings = resolvePiMemSettings(options.settings);
		const store = new PiMemStore(settings.storePath ?? defaultPiMemPath(options.agentDir), {
			storageBackend: settings.storageBackend,
		});
		const haloWriter = new HaloTraceWriter({
			tracePath: defaultHaloTracePath(),
			projectId: "pi",
			serviceName: "pi-mem",
		});
		let lastCtx: ExtensionContext | undefined;
		let pendingPrompt = "";
		let pendingInjection = false;
		let activeHaloContext: HaloActiveContext | undefined;
		const currentNamespaces = () => settings.namespaces;
		const currentNamespace = () => currentNamespaces()[0];
		const currentProjectId = (ctx: ExtensionContext) =>
			settings.projectId ??
			process.env.PI_MEM_PROJECT_ID ??
			process.env.PI_HALO_PROJECT_ID ??
			deriveProjectIdFromCwd(ctx.cwd);
		const saveSettings = (patch: Partial<PiMemResolvedSettings>) => {
			settings = resolvePiMemSettings({ ...settings, ...patch });
			options.updateSettings?.(settings);
		};

		const logOp = async (ctx: ExtensionContext, operation: string, memoryIds: string[], count: number) => {
			try {
				const span = haloWriter.startSpan({
					traceId: activeHaloContext?.traceId,
					parentSpanId: activeHaloContext?.spanId,
					name: `pi_mem.${operation}`,
					observationKind: "TOOL",
					attributes: {
						"inference.agent_name": "pi-mem",
						"pi_mem.operation": operation,
						"pi_mem.count": count,
						"pi_mem.ids": memoryIds,
						"pi.session_id": ctx.sessionManager.getSessionId(),
						"pi.session_file": ctx.sessionManager.getSessionFile(),
						"pi.cwd": ctx.cwd,
						...(activeHaloContext?.traceId ? { "pi.halo.trace_id": activeHaloContext.traceId } : {}),
						...(activeHaloContext?.rootSpanId ? { "pi.halo.root_span_id": activeHaloContext.rootSpanId } : {}),
						...(activeHaloContext?.spanId ? { "pi.halo.parent_span_id": activeHaloContext.spanId } : {}),
						...(activeHaloContext?.kind ? { "pi.halo.parent_kind": activeHaloContext.kind } : {}),
						...(activeHaloContext?.toolName ? { "pi.halo.parent_tool_name": activeHaloContext.toolName } : {}),
						...(activeHaloContext?.toolCallId
							? { "pi.halo.parent_tool_call_id": activeHaloContext.toolCallId }
							: {}),
					},
				});
				await haloWriter.endSpan(span, { statusCode: "STATUS_CODE_OK" });
			} catch {}
		};

		pi.events.on("halo:active_context", (event) => {
			if (!event || typeof event !== "object") return;
			const candidate = event as Partial<HaloActiveContext>;
			if (
				typeof candidate.traceId !== "string" ||
				typeof candidate.rootSpanId !== "string" ||
				typeof candidate.spanId !== "string"
			)
				return;
			if (candidate.kind !== "agent" && candidate.kind !== "turn" && candidate.kind !== "tool") return;
			activeHaloContext = candidate as HaloActiveContext;
		});

		registerPiMemTools(pi, {
			store,
			ctx: () => {
				if (!lastCtx) throw new Error("Pi Mem context unavailable");
				return lastCtx;
			},
			isEnabled: () => settings.enabled,
			maxQueryResults: () => settings.maxQueryResults,
			redactMode: () => settings.redactMode,
			namespace: currentNamespace,
			namespaces: currentNamespaces,
			projectId: currentProjectId,
		});
		pi.on("session_shutdown", async () => {
			await store.close();
		});

		pi.on("before_agent_start", (event, ctx) => {
			lastCtx = ctx;
			pendingPrompt = event.prompt;
			pendingInjection = settings.enabled && settings.autoInject;
		});
		pi.on("context", async (event, ctx) => {
			lastCtx = ctx;
			if (!pendingInjection) return;
			pendingInjection = false;

			const contextWindow = ctx.model?.contextWindow ?? 0;
			let tokenBudget = PI_MEM_MAX_INJECTED_TOKENS;
			if (contextWindow > 0) {
				const estimate = estimateContextTokens(event.messages).tokens;
				const contextPercent = (estimate / contextWindow) * 100;
				if (contextPercent >= PI_MEM_HIGH_CONTEXT_USAGE_PERCENT) {
					await logOp(ctx, "inject_suppressed_high_context", [], 0);
					return;
				}
				tokenBudget = Math.min(
					PI_MEM_MAX_INJECTED_TOKENS,
					Math.max(0, contextWindow - estimate - PI_MEM_MIN_CONTEXT_RESERVE_TOKENS),
				);
				if (tokenBudget <= 0) {
					await logOp(ctx, "inject_suppressed_budget", [], 0);
					return;
				}
			}

			const results = await store.search({
				query: pendingPrompt,
				limit: settings.maxInjected,
				namespaces: currentNamespaces(),
				cwd: ctx.cwd,
				projectId: currentProjectId(ctx),
			});
			const injected = selectInjectedMemoriesWithinBudget(results, tokenBudget);
			if (injected.length === 0) {
				await logOp(ctx, "inject_suppressed_budget", [], 0);
				return;
			}
			await logOp(
				ctx,
				injected.length < results.length ? "inject_capped" : "inject",
				injected.map((m) => m.id),
				injected.length,
			);
			const messages = [...event.messages];
			messages.splice(findLastUserMessageIndex(event.messages), 0, {
				role: "user",
				content: [
					{ type: "text", text: redactLikelySecrets(formatInjectedMemories(injected), settings.redactMode) },
				],
				timestamp: Date.now(),
			});
			return { messages };
		});

		const remember = async (
			ctx: ExtensionContext,
			summary: string,
			content: string,
			source: string,
			citations?: PiMemCitation[],
			metadata?: { type?: PiMemRecordType; tags?: string[]; confidence?: number; importance?: number },
		) => {
			await store.append(
				store.createRecordBase({
					type: metadata?.type ?? "observation",
					summary: redactLikelySecrets(summary, settings.redactMode),
					content: redactLikelySecrets(content, settings.redactMode),
					tags: [...new Set(["auto", ...(metadata?.tags ?? [])])],
					namespace: currentNamespace(),
					projectId: currentProjectId(ctx),
					cwd: ctx.cwd,
					sessionId: ctx.sessionManager.getSessionId(),
					sessionFile: ctx.sessionManager.getSessionFile() ?? "",
					source,
					citations,
					confidence: metadata?.confidence,
					importance: metadata?.importance,
				}),
			);
		};

		pi.on("message_end", async (event, ctx) => {
			if (!settings.enabled || !settings.autoExtract) return;
			for (const c of extractMemoryCandidatesFromMessage(event.message, settings.extractionMode).slice(0, 2))
				await remember(ctx, c.summary, c.content, "message_end", activeHaloContext ? [activeHaloContext] : [], c);
		});
		pi.on("tool_result", async (event, ctx) => {
			if (!settings.enabled || !settings.autoExtract) return;
			for (const c of extractMemoryCandidatesFromToolResult(event, settings.extractionMode).slice(0, 1))
				await remember(
					ctx,
					c.summary,
					c.content,
					"tool_result",
					[{ toolName: event.toolName }, ...(activeHaloContext ? [activeHaloContext] : [])],
					c,
				);
		});

		pi.registerCommand("mem", {
			description: "Manage Pi Mem",
			handler: async (args, ctx) => {
				lastCtx = ctx;
				const t = args.trim().split(/\s+/).filter(Boolean);
				const cmd = t[0] ?? "status";
				if (cmd === "on") saveSettings({ enabled: true });
				else if (cmd === "off") saveSettings({ enabled: false });
				else if (cmd === "namespace") {
					if (t[1] === "list")
						pi.sendMessage(
							{ customType: "pi-mem", content: `Namespaces: ${currentNamespaces().join(", ")}`, display: true },
							{ triggerTurn: false },
						);
					else if (t[1] === "set" && t[2])
						saveSettings({ namespaces: [t[2], ...currentNamespaces().filter((n) => n !== t[2])] });
					else if (t[1] === "clear") saveSettings({ namespaces: [] });
					return;
				} else if (cmd === "maintenance" && t[1] === "compact") {
					const r = await store.maintenance("compact");
					pi.sendMessage(
						{ customType: "pi-mem", content: `Maintenance compact: ${r.status} (${r.backend})`, display: true },
						{ triggerTurn: false },
					);
					return;
				} else if (cmd === "purge") {
					const global = t.includes("--global");
					if (global && !ctx.hasUI && !t.includes("--yes")) {
						pi.sendMessage(
							{ customType: "pi-mem", content: "Global purge requires --yes in headless mode.", display: true },
							{ triggerTurn: false },
						);
						return;
					}
					if (global && ctx.hasUI && !(await ctx.ui.confirm("Confirm purge", "Purge global Pi Mem memories?")))
						return;
					const removed = await store.purge({
						cwd: global ? undefined : ctx.cwd,
						namespace: currentNamespace(),
						projectId: currentProjectId(ctx),
						includePinned: t.includes("--include-pinned"),
						includeWrong: t.includes("--include-wrong"),
					});
					pi.sendMessage(
						{ customType: "pi-mem", content: `Purged ${removed} memories.`, display: true },
						{ triggerTurn: false },
					);
					return;
				} else if (cmd === "view" && t[1]) {
					const m = await store.get(t[1]);
					pi.sendMessage(
						{
							customType: "pi-mem",
							content: m ? `${m.id}\n${m.type}: ${m.summary}\n${m.content}` : "Memory not found",
							display: true,
						},
						{ triggerTurn: false },
					);
					return;
				} else if (cmd === "timeline") {
					const rows = await store.timeline({
						limit: 30,
						cwd: ctx.cwd,
						namespaces: currentNamespaces(),
						projectId: currentProjectId(ctx),
					});
					const json = t.includes("--json");
					pi.sendMessage(
						{
							customType: "pi-mem",
							content: json
								? JSON.stringify(rows, null, 2)
								: rows
										.map((m) => `${new Date(m.createdAt).toISOString()} ${m.id.slice(0, 8)} ${m.summary}`)
										.join("\n"),
							display: true,
						},
						{ triggerTurn: false },
					);
					return;
				}
				const all = await store.search({
					limit: 10,
					cwd: ctx.cwd,
					namespaces: currentNamespaces(),
					projectId: currentProjectId(ctx),
				});
				pi.sendMessage(
					{
						customType: "pi-mem",
						content: formatStatusMessage(settings, settings.storePath ?? defaultPiMemPath(options.agentDir), all),
						display: true,
					},
					{ triggerTurn: false },
				);
			},
		});
	};
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function findLastUserMessageIndex(messages: Array<{ role: string }>): number {
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
	return messages.length;
}

function formatStatusMessage(settings: PiMemResolvedSettings, storePath: string, recent: PiMemRecord[]): string {
	return `Pi Mem status\n- enabled: ${settings.enabled}\n- autoExtract: ${settings.autoExtract}\n- autoInject: ${settings.autoInject}\n- extraction: ${settings.extractionMode}${settings.extractionModel ? ` (${settings.extractionModel})` : ""}\n- backend: ${settings.storageBackend}\n- projectId: ${settings.projectId ?? "auto"}\n- namespaces: ${(settings.namespaces ?? []).join(",") || "all"}\n- store: ${storePath}\n- recent: ${recent.length}`;
}

function deriveProjectIdFromCwd(cwd: string): string {
	const base = basename(cwd)
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return base || "default";
}
