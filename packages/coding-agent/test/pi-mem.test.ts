import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/index.js";
import {
	createPiMemExtension,
	extractMemoryCandidatesFromMessage,
	extractMemoryCandidatesFromToolResult,
	PiMemStore,
	redactLikelySecrets,
} from "../src/core/pi-mem/index.js";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./suite/harness.js";

let dir: string;
const harnesses: Harness[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-mem-"));
});

afterEach(async () => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
	await rm(dir, { recursive: true, force: true });
});

describe("Pi Mem", () => {
	it("redacts likely secrets", () => {
		expect(redactLikelySecrets("token=sk_abcdefghijklmnopqrstuvwxyz")).toContain("[REDACTED]");
	});

	it("stores and searches records", async () => {
		const store = new PiMemStore(join(dir, "memories.jsonl"));
		await store.append(
			store.createRecordBase({
				type: "note",
				summary: "Build succeeded",
				content: "Typecheck passed",
				tags: ["build"],
				cwd: dir,
				sessionId: "s1",
				sessionFile: "session.jsonl",
				source: "test",
			}),
		);
		const found = await store.search("typecheck", 10);
		expect(found).toHaveLength(1);
		expect(found[0]?.summary).toBe("Build succeeded");
	});

	it("deduplicates and merges on append", async () => {
		const store = new PiMemStore(join(dir, "memories.jsonl"));
		const first = await store.append(
			store.createRecordBase({
				type: "fix",
				summary: "Auth fix: clear stale oauth state",
				content: "Fixed auth by clearing stale OAuth state before login retry.",
				tags: ["auth", "oauth"],
				cwd: dir,
				sessionId: "s1",
				sessionFile: "session.jsonl",
				source: "test-a",
			}),
		);
		const second = await store.append(
			store.createRecordBase({
				type: "fix",
				summary: "Authentication fix clears stale oauth state",
				content: "Fixed auth by clearing stale OAuth state before retrying login flow.",
				tags: ["auth", "login"],
				cwd: dir,
				sessionId: "s2",
				sessionFile: "session.jsonl",
				source: "test-b",
			}),
		);
		expect(second.id).toBe(first.id);
		const all = await store.list();
		expect(all).toHaveLength(1);
		expect(all[0]?.tags.sort()).toEqual(["auth", "login", "oauth"].sort());
		expect(all[0]?.source).toContain("test-a");
		expect(all[0]?.source).toContain("test-b");
	});

	it("extracts richer categories from messages and tool results", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Decision: we prefer ripgrep for fast code search and fixed flaky tests." }],
		} as any;
		const candidates = extractMemoryCandidatesFromMessage(message);
		expect(candidates[0]?.type).toBe("preference");
		expect(candidates[0]?.tags).toContain("preference");

		const tool = {
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "Command failed: rollback_reason timeout" }],
		} as any;
		const toolCandidates = extractMemoryCandidatesFromToolResult(tool);
		expect(toolCandidates[0]?.type).toBe("failed_attempt");
	});

	it("ranks by overlap and feedback, while decaying stale older memories", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const store = new PiMemStore(join(dir, "memories.jsonl"));
		await store.append(
			store.createRecordBase({
				type: "fact",
				summary: "Use npm ci in CI",
				content: "CI should use npm ci for deterministic installs",
				tags: ["ci"],
				cwd: dir,
				sessionId: "s1",
				sessionFile: "session.jsonl",
				source: "test",
				importance: 0.9,
				confidence: 0.9,
				usefulCount: 4,
			}),
		);
		vi.setSystemTime(new Date("2026-04-15T00:00:00Z"));
		await store.append(
			store.createRecordBase({
				type: "fact",
				summary: "CI note",
				content: "Sometimes npm install works",
				tags: ["ci"],
				cwd: dir,
				sessionId: "s2",
				sessionFile: "session.jsonl",
				source: "test",
				importance: 0.4,
				confidence: 0.4,
				stale: true,
				staleCount: 2,
			}),
		);
		const found = await store.search("ci npm deterministic", 10);
		expect(found[0]?.summary).toBe("Use npm ci in CI");
		vi.useRealTimers();
	});

	it("supports feedback and stats", async () => {
		const store = new PiMemStore(join(dir, "memories.jsonl"));
		const record = await store.append(
			store.createRecordBase({
				type: "fact",
				summary: "Use ripgrep",
				content: "Prefer rg for fast search",
				tags: ["search"],
				cwd: dir,
				sessionId: "s1",
				sessionFile: "session.jsonl",
				source: "test",
			}),
		);
		await store.setFeedback(record.id, { pinned: true, usefulDelta: 1 });
		const stats = await store.stats({ cwd: dir, projectId: undefined });
		expect(stats.total).toBe(1);
		expect(stats.pinned).toBe(1);
	});

	it("filters by projectId and supports maintenance compact", async () => {
		const store = new PiMemStore(join(dir, "memories.jsonl"), { storageBackend: "auto" });
		await store.append(
			store.createRecordBase({
				type: "note",
				summary: "A",
				content: "A",
				tags: [],
				projectId: "p1",
				cwd: dir,
				sessionId: "s1",
				sessionFile: "session.jsonl",
				source: "test",
			}),
		);
		await store.append(
			store.createRecordBase({
				type: "note",
				summary: "B",
				content: "B",
				tags: [],
				projectId: "p2",
				cwd: dir,
				sessionId: "s1",
				sessionFile: "session.jsonl",
				source: "test",
			}),
		);
		const p1 = await store.search({ projectId: "p1" });
		expect(p1).toHaveLength(1);
		const maintenance = await store.maintenance("compact");
		expect(maintenance.action).toBe("compact");
		await store.close();
	});

	it("purges unpinned project memories", async () => {
		const store = new PiMemStore(join(dir, "memories.jsonl"));
		await store.append(
			store.createRecordBase({
				type: "note",
				summary: "Temp",
				content: "remove me",
				tags: [],
				cwd: dir,
				sessionId: "s1",
				sessionFile: "session.jsonl",
				source: "test",
			}),
		);
		await store.append(
			store.createRecordBase({
				type: "note",
				summary: "Keep",
				content: "pinned",
				tags: [],
				cwd: dir,
				sessionId: "s1",
				sessionFile: "session.jsonl",
				source: "test",
				pinned: true,
			}),
		);
		const removed = await store.purge({ cwd: dir });
		expect(removed).toBe(1);
		expect(await store.list()).toHaveLength(1);
	});

	it("injects matching project memories transiently", async () => {
		const storePath = join(dir, "memories.jsonl");
		const harness = await createHarness({
			extensionFactories: [
				createPiMemExtension({
					cwd: dir,
					agentDir: dir,
					settings: { storePath, autoExtract: false },
				}),
			],
		});
		harnesses.push(harness);
		const store = new PiMemStore(storePath);
		await store.append(
			store.createRecordBase({
				type: "fact",
				summary: "Authentication bug was fixed by clearing stale OAuth state",
				content: "The auth bug fix is to clear stale OAuth state before retrying login.",
				tags: ["auth"],
				cwd: harness.tempDir,
				sessionId: "s1",
				sessionFile: "session.jsonl",
				source: "test",
			}),
		);
		let providerText = "";
		harness.setResponses([
			(context) => {
				providerText = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("What did we learn about the auth bug?");

		expect(providerText).toContain("Relevant Pi Mem memories");
		expect(providerText).toContain("Authentication bug was fixed");
		expect(getUserTexts(harness)).toEqual(["What did we learn about the auth bug?"]);
	});

	it("links Pi Mem HALO spans to active HALO trace context", async () => {
		const storePath = join(dir, "memories.jsonl");
		const tracePath = join(dir, "traces.jsonl");
		const originalPath = process.env.PI_HALO_TRACES_PATH;
		process.env.PI_HALO_TRACES_PATH = tracePath;
		const haloContextEmitter = (pi: ExtensionAPI) => {
			pi.on("agent_start", () => {
				pi.events.emit("halo:active_context", {
					traceId: "trace-123",
					rootSpanId: "root-123",
					spanId: "span-456",
					kind: "turn",
				});
			});
		};
		try {
			const harness = await createHarness({
				extensionFactories: [
					haloContextEmitter,
					createPiMemExtension({ cwd: dir, agentDir: dir, settings: { storePath, autoExtract: false } }),
				],
			});
			harnesses.push(harness);
			const store = new PiMemStore(storePath);
			await store.append(
				store.createRecordBase({
					type: "fact",
					summary: "Use deterministic installs",
					content: "Use npm ci in CI",
					tags: ["ci"],
					cwd: harness.tempDir,
					sessionId: "s1",
					sessionFile: "session.jsonl",
					source: "test",
				}),
			);
			harness.setResponses([(context) => fauxAssistantMessage(context.messages.length > 0 ? "ok" : "no")]);
			await harness.session.prompt("How should CI install dependencies?");

			const lines = (await readFile(tracePath, "utf8")).trim().split("\n").filter(Boolean);
			const spans = lines.map(
				(line) =>
					JSON.parse(line) as {
						name: string;
						trace_id: string;
						parent_span_id: string;
						attributes?: Record<string, unknown>;
					},
			);
			const piMemSpan = spans.find((span) => span.name === "pi_mem.inject");
			expect(piMemSpan).toBeDefined();
			expect(piMemSpan?.trace_id).toBe("trace-123");
			expect(piMemSpan?.parent_span_id).toBe("span-456");
			expect(piMemSpan?.attributes?.["pi.halo.root_span_id"]).toBe("root-123");
		} finally {
			if (originalPath === undefined) delete process.env.PI_HALO_TRACES_PATH;
			else process.env.PI_HALO_TRACES_PATH = originalPath;
		}
	});
});
