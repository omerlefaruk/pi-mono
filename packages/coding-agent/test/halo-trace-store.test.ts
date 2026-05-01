import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HaloTraceStore, HaloTraceWriter } from "../src/core/halo/index.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-halo-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("HaloTraceStore", () => {
	it("indexes, filters, views, and searches HALO spans", async () => {
		const tracePath = join(dir, "traces.jsonl");
		const writer = new HaloTraceWriter({ tracePath, projectId: "proj", serviceName: "svc" });
		const agent = writer.startSpan({
			traceId: "trace-a",
			name: "agent.pi",
			observationKind: "AGENT",
			startTime: 1,
			attributes: { "inference.agent_name": "pi" },
		});
		await writer.endSpan(agent, { endTime: 2 });
		const llm = writer.startSpan({
			traceId: "trace-a",
			name: "response.model",
			observationKind: "LLM",
			startTime: 3,
			attributes: {
				"inference.agent_name": "pi",
				"inference.llm.model_name": "model",
				"inference.llm.input_tokens": 10,
				"inference.llm.output_tokens": 5,
				"output.value": "needle",
			},
		});
		await writer.endSpan(llm, { endTime: 4 });
		const error = writer.startSpan({
			traceId: "trace-b",
			name: "function.bash",
			observationKind: "TOOL",
			startTime: 5,
			attributes: { "tool.name": "bash", "output.value": "boom" },
		});
		await writer.endSpan(error, { endTime: 6, statusCode: "STATUS_CODE_ERROR", statusMessage: "boom" });

		const store = await HaloTraceStore.load(tracePath);
		expect(store.traceCount).toBe(2);
		expect(store.getOverview({ project_id: "proj" })).toMatchObject({
			total_traces: 2,
			total_spans: 3,
			error_trace_count: 1,
			total_input_tokens: 10,
			total_output_tokens: 5,
			service_names: ["svc"],
			model_names: ["model"],
			agent_names: ["pi"],
		});
		expect(store.queryTraces({ has_errors: true }).traces.map((trace) => trace.trace_id)).toEqual(["trace-b"]);

		const view = await store.viewTrace("trace-a");
		expect(view.spans.map((span) => span.name)).toEqual(["agent.pi", "response.model"]);
		const search = await store.searchTrace("trace-a", "needle");
		expect(search.match_count).toBe(1);
		expect(search.matches[0]).toContain("needle");
		const selected = await store.viewSpans("trace-a", [view.spans[1]?.span_id ?? ""]);
		expect(selected.spans).toHaveLength(1);
		expect(selected.spans[0]?.name).toBe("response.model");
	});

	it("skips corrupt JSONL rows and reports index health", async () => {
		const tracePath = join(dir, "corrupt-traces.jsonl");
		const writer = new HaloTraceWriter({ tracePath, projectId: "proj", serviceName: "svc" });
		const span = writer.startSpan({ traceId: "trace-ok", name: "agent.pi", observationKind: "AGENT", startTime: 1 });
		await writer.endSpan(span, { endTime: 2 });
		await appendFile(tracePath, "{not json}\n", "utf8");
		const span2 = writer.startSpan({
			traceId: "trace-ok-2",
			name: "response.model",
			observationKind: "LLM",
			startTime: 3,
		});
		await writer.endSpan(span2, { endTime: 4 });

		const store = await HaloTraceStore.load(tracePath);
		expect(store.traceCount).toBe(2);
		expect(store.getOverview().index_health).toMatchObject({ corrupt_span_count: 1, first_corrupt_line: 2 });
	});

	it("rebuilds a corrupt sidecar index", async () => {
		const tracePath = join(dir, "rebuild-traces.jsonl");
		const writer = new HaloTraceWriter({ tracePath, projectId: "proj", serviceName: "svc" });
		const span = writer.startSpan({ traceId: "trace-a", name: "agent.pi", observationKind: "AGENT", startTime: 1 });
		await writer.endSpan(span, { endTime: 2 });
		const store = await HaloTraceStore.load(tracePath);
		await writeFile(store.indexPath, "{bad index}\n", "utf8");

		const rebuilt = await HaloTraceStore.load(tracePath);
		expect(rebuilt.traceCount).toBe(1);
		expect((await rebuilt.viewTrace("trace-a")).spans).toHaveLength(1);
	});
});
