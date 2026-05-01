import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../extensions/index.js";
import { redactLikelySecrets } from "./redaction.js";
import type { PiMemStore } from "./store.js";
import type { PiMemResolvedSettings } from "./types.js";

const SearchSchema = Type.Object({
	query: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
	namespace: Type.Optional(Type.String()),
	projectId: Type.Optional(Type.String()),
	include_all_projects: Type.Optional(Type.Boolean()),
});
const GetSchema = Type.Object({ id: Type.String() });
const RememberSchema = Type.Object({
	summary: Type.String({ minLength: 1 }),
	content: Type.String({ minLength: 1 }),
	tags: Type.Optional(Type.Array(Type.String())),
	namespace: Type.Optional(Type.String()),
	projectId: Type.Optional(Type.String()),
	privacy: Type.Optional(Type.Union([Type.Literal("public"), Type.Literal("private"), Type.Literal("sensitive")])),
});
const ForgetSchema = Type.Object({ id: Type.String() });
const TimelineSchema = Type.Object({
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
	namespace: Type.Optional(Type.String()),
	projectId: Type.Optional(Type.String()),
	include_all_projects: Type.Optional(Type.Boolean()),
});
const FeedbackSchema = Type.Object({
	id: Type.String(),
	action: Type.Union([Type.Literal("pin"), Type.Literal("stale"), Type.Literal("wrong"), Type.Literal("useful")]),
});
const StatsSchema = Type.Object({
	namespace: Type.Optional(Type.String()),
	projectId: Type.Optional(Type.String()),
	include_all_projects: Type.Optional(Type.Boolean()),
});
const MaintenanceSchema = Type.Object({ action: Type.Optional(Type.Union([Type.Literal("compact")])) });

export function registerPiMemTools(
	pi: ExtensionAPI,
	deps: {
		store: PiMemStore;
		ctx: () => ExtensionContext;
		isEnabled: () => boolean;
		maxQueryResults: () => number;
		redactMode: () => PiMemResolvedSettings["redactMode"];
		namespace: () => string | undefined;
		namespaces: () => string[];
		projectId: (ctx: ExtensionContext) => string;
	},
): void {
	pi.registerTool({
		name: "pi_mem_search",
		label: "Pi Mem Search",
		description: "Search Pi Mem project memory.",
		parameters: SearchSchema,
		async execute(_toolCallId, params: Static<typeof SearchSchema>) {
			const ctx = deps.ctx();
			const result = await deps.store.search({
				query: params.query,
				limit: params.limit ?? deps.maxQueryResults(),
				namespace: params.namespace,
				namespaces: params.namespace ? undefined : deps.namespaces(),
				projectId: params.projectId ?? deps.projectId(ctx),
				cwd: params.include_all_projects ? undefined : ctx.cwd,
			});
			return {
				content: [
					{
						type: "text",
						text: result.length === 0 ? "No matching memories." : `Found ${result.length} memories`,
					},
				],
				details: { result },
			};
		},
	});
	pi.registerTool({
		name: "pi_mem_get",
		label: "Pi Mem Get",
		description: "Get one Pi Mem memory by id.",
		parameters: GetSchema,
		async execute(_toolCallId, params: Static<typeof GetSchema>) {
			const result = await deps.store.get(params.id);
			return { content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }], details: { result } };
		},
	});
	pi.registerTool({
		name: "pi_mem_remember",
		label: "Pi Mem Remember",
		description: "Store an explicit Pi Mem memory.",
		parameters: RememberSchema,
		async execute(_toolCallId, params: Static<typeof RememberSchema>) {
			if (!deps.isEnabled()) throw new Error("Pi Mem is disabled.");
			const runtimeCtx = deps.ctx();
			const record = await deps.store.append(
				deps.store.createRecordBase({
					type: "note",
					summary: redactLikelySecrets(params.summary, deps.redactMode()),
					content: redactLikelySecrets(params.content, deps.redactMode()),
					tags: params.tags,
					namespace: params.namespace ?? deps.namespace(),
					projectId: params.projectId ?? deps.projectId(runtimeCtx),
					cwd: runtimeCtx.cwd,
					sessionId: runtimeCtx.sessionManager.getSessionId(),
					sessionFile: runtimeCtx.sessionManager.getSessionFile() ?? "",
					source: "tool:pi_mem_remember",
					privacy: params.privacy,
				}),
			);
			return { content: [{ type: "text", text: JSON.stringify(record, null, 2) }], details: { result: record } };
		},
	});
	pi.registerTool({
		name: "pi_mem_forget",
		label: "Pi Mem Forget",
		description: "Delete a Pi Mem memory by id.",
		parameters: ForgetSchema,
		async execute(_toolCallId, params: Static<typeof ForgetSchema>) {
			const deleted = await deps.store.forget(params.id);
			return {
				content: [
					{ type: "text", text: deleted ? `Forgot memory ${params.id}.` : `Memory not found: ${params.id}` },
				],
				details: { deleted },
			};
		},
	});
	pi.registerTool({
		name: "pi_mem_timeline",
		label: "Pi Mem Timeline",
		description: "List recent Pi Mem memories.",
		parameters: TimelineSchema,
		async execute(_toolCallId, params: Static<typeof TimelineSchema>) {
			const ctx = deps.ctx();
			const result = await deps.store.timeline({
				limit: params.limit ?? deps.maxQueryResults(),
				namespace: params.namespace ?? deps.namespace(),
				cwd: params.include_all_projects ? undefined : ctx.cwd,
				projectId: params.projectId ?? deps.projectId(ctx),
			});
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: { result } };
		},
	});
	pi.registerTool({
		name: "pi_mem_feedback",
		label: "Pi Mem Feedback",
		description: "Apply feedback to a memory.",
		parameters: FeedbackSchema,
		async execute(_toolCallId, params: Static<typeof FeedbackSchema>) {
			const patch =
				params.action === "pin"
					? { pinned: true }
					: params.action === "stale"
						? { stale: true, staleDelta: 1 }
						: params.action === "wrong"
							? { wrong: true, wrongDelta: 1 }
							: { usefulDelta: 1 };
			const updated = await deps.store.setFeedback(params.id, patch);
			return {
				content: [
					{
						type: "text",
						text: updated ? `Updated ${params.id} with ${params.action}.` : `Memory not found: ${params.id}`,
					},
				],
				details: { updated },
			};
		},
	});
	pi.registerTool({
		name: "pi_mem_stats",
		label: "Pi Mem Stats",
		description: "Get memory stats.",
		parameters: StatsSchema,
		async execute(_toolCallId, params: Static<typeof StatsSchema>) {
			const ctx = deps.ctx();
			const result = await deps.store.stats({
				namespace: params.namespace ?? deps.namespace(),
				namespaces: params.namespace ? undefined : deps.namespaces(),
				projectId: params.projectId ?? deps.projectId(ctx),
				cwd: params.include_all_projects ? undefined : ctx.cwd,
			});
			return { content: [{ type: "text", text: `Pi Mem stats\n- total: ${result.total}` }], details: { result } };
		},
	});
	pi.registerTool({
		name: "pi_mem_maintenance",
		label: "Pi Mem Maintenance",
		description: "Run Pi Mem maintenance operations.",
		parameters: MaintenanceSchema,
		async execute(_toolCallId, params: Static<typeof MaintenanceSchema>) {
			const result = await deps.store.maintenance(params.action ?? "compact");
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: { result } };
		},
	});
}
