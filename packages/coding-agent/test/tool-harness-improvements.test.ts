import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractBarePathInput } from "../src/core/agent-session.js";
import type { ExtensionContext } from "../src/core/extensions/index.js";
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
		const ctx = {} as ExtensionContext;

		await expect(tool.execute("call", { command: '"C:/Program Files/Git/halo-status"' }, ctx, undefined, undefined)).rejects.toThrow(
			"Refusing to execute a bare path",
		);
		expect(executed).toBe(false);
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
