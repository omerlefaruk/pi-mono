import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { extractBarePathInput } from "../src/core/agent-session.js";
import type { ExtensionContext } from "../src/core/extensions/index.js";
import { summarizeToolResult } from "../src/core/halo/index.js";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.js";
import { createFindToolDefinition } from "../src/core/tools/find.js";

describe("tool harness improvements", () => {
	it("rejects bare path bash commands before execution", async () => {
		let executed = false;
		const operations: BashOperations = {
			exec: async () => {
				executed = true;
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });

		await expect(
			tool.execute(
				"call",
				{ command: '"C:/Program Files/Git/halo-status"' },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("slash command converted");
		expect(executed).toBe(false);
	});

	it("rejects PowerShell syntax before executing bash", async () => {
		let executed = false;
		const operations: BashOperations = {
			exec: async () => {
				executed = true;
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });

		await expect(
			tool.execute(
				"call",
				{ command: "Get-ChildItem | Select-Object -First 1" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("PowerShell syntax");
		expect(executed).toBe(false);
	});

	it("rejects incompatible Vitest command profiles before execution", async () => {
		let executed = false;
		const operations: BashOperations = {
			exec: async () => {
				executed = true;
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });

		await expect(
			tool.execute(
				"call",
				{ command: "npx vitest --runInBand test/foo.test.ts" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("Vitest does not support");
		expect(executed).toBe(false);
	});

	it("blocks repeated bash failures after two similar attempts", async () => {
		let executions = 0;
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				executions++;
				onData(Buffer.from("same failure\n"));
				return { exitCode: 1 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });

		await expect(
			tool.execute("call-1", { command: "npm run nope" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("same failure");
		await expect(
			tool.execute("call-2", { command: "npm run nope" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("same failure");
		await expect(
			tool.execute("call-3", { command: "npm run nope" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("Repeated bash failure detected");
		expect(executions).toBe(2);
	});

	it("runs git commit identity preflight before mutation", async () => {
		let commitExecuted = false;
		const operations: BashOperations = {
			exec: async (command) => {
				if (command.startsWith("git rev-parse --is-inside-work-tree")) return { exitCode: 0 };
				if (command.startsWith("state=$(")) return { exitCode: 0 };
				if (command.startsWith('test -n "$(git config --get user.name)"')) return { exitCode: 1 };
				if (command.startsWith("git commit")) commitExecuted = true;
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });

		await expect(
			tool.execute("call", { command: "git commit -m test" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("committer identity is not configured");
		expect(commitExecuted).toBe(false);
	});

	it("compacts halo tool result content in trace summaries", () => {
		const result = summarizeToolResult({
			role: "toolResult",
			toolCallId: "call",
			toolName: "halo_view_trace",
			isError: false,
			content: [{ type: "text", text: "x".repeat(20_000) }],
			details: { result: { trace_id: "trace", spans: [{ span_id: "span" }] } },
		} as ToolResultMessage);

		expect(result.content).toMatchObject({ type: "halo_compact_content", text_bytes: 20_000 });
		expect(JSON.stringify(result)).not.toContain("xxxxx");
	});

	it("recognizes bare path prompts so they can be inspected instead of executed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-bare-path-"));
		try {
			await writeFile(join(dir, "README.md"), "hello", "utf8");
			expect(extractBarePathInput('"README.md"', dir)).toBe("README.md");
			expect(extractBarePathInput("README.md && rm -rf .", dir)).toBeUndefined();
			expect(extractBarePathInput("please read README.md", dir)).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("deduplicates find results from custom glob backends", async () => {
		const tool = createFindToolDefinition("/repo", {
			operations: {
				exists: () => true,
				glob: () => ["/repo/src/a.ts", "/repo/src/a.ts", "/repo/src/b.ts"],
			},
		});

		const result = await tool.execute("call", { pattern: "**/*.ts" }, undefined, undefined, {} as ExtensionContext);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text.split("\n")).toEqual(["src/a.ts", "src/b.ts"]);
	});
});
