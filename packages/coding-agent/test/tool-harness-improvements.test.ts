import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

	it("allows explicit relative executable scripts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-bash-script-"));
		try {
			const scriptPath = join(dir, "autoresearch.sh");
			await writeFile(scriptPath, "#!/usr/bin/env bash\necho ok\n", "utf8");
			await chmod(scriptPath, 0o755);
			let executed = false;
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					executed = true;
					onData(Buffer.from("ok\n"));
					return { exitCode: 0 };
				},
			};
			const tool = createBashToolDefinition(dir, { operations });

			const result = await tool.execute(
				"call",
				{ command: "./autoresearch.sh" },
				undefined,
				undefined,
				{} as ExtensionContext,
			);

			expect(executed).toBe(true);
			expect(result.content[0]).toMatchObject({ type: "text", text: "ok\n" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
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

	it("rejects duplicate Vitest --run flags before execution", async () => {
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
				{ command: "npx vitest --run --run test/foo.test.ts" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("--run was specified more than once");
		expect(executed).toBe(false);
	});

	it("rejects npm script Vitest duplicate --run flags before execution", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-vite-script-"));
		try {
			await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest --run" } }), "utf8");
			let executed = false;
			const operations: BashOperations = {
				exec: async () => {
					executed = true;
					return { exitCode: 0 };
				},
			};
			const tool = createBashToolDefinition(dir, { operations });

			await expect(
				tool.execute(
					"call",
					{ command: "npm run test -- --run test/foo.test.ts" },
					undefined,
					undefined,
					{} as ExtensionContext,
				),
			).rejects.toThrow("already includes vitest --run");
			expect(executed).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("does not preflight npm scripts after an inline cd", async () => {
		let executed = false;
		const operations: BashOperations = {
			exec: async (command) => {
				if (command.startsWith("cd child && npm run child-script")) executed = true;
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });

		await tool.execute(
			"call",
			{ command: "cd child && npm run child-script" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(executed).toBe(true);
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
			tool.execute("call-1", { command: "node nope.js" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("same failure");
		await expect(
			tool.execute("call-2", { command: "node nope.js" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("same failure");
		await expect(
			tool.execute("call-3", { command: "node nope.js" }, undefined, undefined, {} as ExtensionContext),
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

	it("rejects git commands outside a worktree before execution", async () => {
		let gitStatusExecuted = false;
		const operations: BashOperations = {
			exec: async (command) => {
				if (command.startsWith("git rev-parse --is-inside-work-tree")) return { exitCode: 1 };
				if (command.startsWith("git status")) gitStatusExecuted = true;
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });

		await expect(
			tool.execute("call", { command: "git status" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("not inside a git worktree");
		expect(gitStatusExecuted).toBe(false);
	});

	it("uses git -C target for worktree preflight", async () => {
		const preflightCwds: string[] = [];
		let gitStatusExecuted = false;
		const operations: BashOperations = {
			exec: async (command, cwd) => {
				if (command.startsWith("git rev-parse --is-inside-work-tree")) {
					preflightCwds.push(cwd);
					return { exitCode: 0 };
				}
				if (command.startsWith("git -C repo status")) gitStatusExecuted = true;
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition("/workspace", { operations });

		await tool.execute("call", { command: "git -C repo status" }, undefined, undefined, {} as ExtensionContext);
		expect(preflightCwds).toEqual([resolve("/workspace", "repo")]);
		expect(gitStatusExecuted).toBe(true);
	});

	it("does not run git worktree preflight after an inline cd", async () => {
		let gitStatusExecuted = false;
		const operations: BashOperations = {
			exec: async (command) => {
				if (command.startsWith("git rev-parse --is-inside-work-tree")) return { exitCode: 1 };
				if (command.startsWith("cd repo && git status")) gitStatusExecuted = true;
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });

		await tool.execute("call", { command: "cd repo && git status" }, undefined, undefined, {} as ExtensionContext);
		expect(gitStatusExecuted).toBe(true);
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
			expect(extractBarePathInput("src/index.ts", dir)).toBe("src/index.ts");
			expect(extractBarePathInput("README.md && rm -rf .", dir)).toBeUndefined();
			expect(extractBarePathInput("please read README.md", dir)).toBeUndefined();
			expect(extractBarePathInput("https://pi.dev/packages/pi-mermaid", dir)).toBeUndefined();
			expect(extractBarePathInput("pi.dev/packages/pi-mermaid", dir)).toBeUndefined();
			expect(extractBarePathInput("implement https://pi.dev/packages/pi-mermaid", dir)).toBeUndefined();
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
