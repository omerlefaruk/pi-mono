import { describe, expect, it } from "vitest";
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

		await expect(tool.execute("call", { command: '"C:/Program Files/Git/halo-status"' }, undefined, undefined, undefined)).rejects.toThrow(
			"Refusing to execute a bare path",
		);
		expect(executed).toBe(false);
	});

	it("deduplicates find results from custom glob backends", async () => {
		const tool = createFindToolDefinition("/repo", {
			operations: {
				exists: () => true,
				glob: () => ["/repo/src/a.ts", "/repo/src/a.ts", "/repo/src/b.ts"],
			},
		});

		const result = await tool.execute("call", { pattern: "**/*.ts" }, undefined, undefined, undefined);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text.split("\n")).toEqual(["src/a.ts", "src/b.ts"]);
	});
});
