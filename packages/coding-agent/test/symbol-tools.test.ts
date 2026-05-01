import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import {
	createInsertAfterSymbolToolDefinition,
	createInsertBeforeSymbolToolDefinition,
	createReadSymbolToolDefinition,
	createRenameSymbolToolDefinition,
	createReplaceSymbolBodyToolDefinition,
	createSafeDeleteSymbolToolDefinition,
	createSymbolOverviewToolDefinition,
} from "../src/core/tools/symbol-tools.js";

const testContext = {} as ExtensionContext;

function textOf(result: Awaited<ReturnType<ReturnType<typeof createSymbolOverviewToolDefinition>["execute"]>>): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n");
}

describe("symbol tools", () => {
	const dirs: string[] = [];

	function makeDir(): string {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-symbol-tools-"));
		dirs.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("returns compact symbol outlines and reads one symbol on demand", async () => {
		const dir = makeDir();
		const file = path.join(dir, "sample.ts");
		writeFileSync(
			file,
			`export class Greeter {
	greet(options: { name: string }): { message: string } {
		return { message: "hello " + options.name };
	}
}

export function helper() {
	return 1;
}
`,
		);

		const overview = createSymbolOverviewToolDefinition(dir);
		const overviewText = textOf(
			await overview.execute("call-1", { path: "sample.ts" }, undefined, undefined, testContext),
		);
		expect(overviewText).toContain("Greeter [class] lines 1-5");
		expect(overviewText).toContain("Greeter.greet [method] lines 2-4");
		expect(overviewText).toContain("helper [function] lines 7-9");

		const readSymbol = createReadSymbolToolDefinition(dir);
		const symbolText = textOf(
			await readSymbol.execute(
				"call-2",
				{ path: "sample.ts", symbol: "Greeter.greet" },
				undefined,
				undefined,
				testContext,
			),
		);
		expect(symbolText).toContain("sample.ts:2-4 Greeter.greet");
		expect(symbolText).toContain('return { message: "hello " + options.name };');
		expect(symbolText).not.toContain("export function helper");
	});

	it("replaces a symbol body while preserving the declaration", async () => {
		const dir = makeDir();
		const file = path.join(dir, "sample.ts");
		writeFileSync(
			file,
			`function add(options: { a: number; b: number }): { value: number } {
	return { value: options.a + options.b };
}
`,
		);

		const tool = createReplaceSymbolBodyToolDefinition(dir);
		await tool.execute(
			"call-1",
			{ path: "sample.ts", symbol: "add", body: "return { value: options.a - options.b };" },
			undefined,
			undefined,
			testContext,
		);

		expect(readFileSync(file, "utf-8")).toBe(`function add(options: { a: number; b: number }): { value: number } {
	return { value: options.a - options.b };
}
`);
	});

	it("inserts before and after symbol ranges without line numbers", async () => {
		const dir = makeDir();
		const file = path.join(dir, "sample.ts");
		writeFileSync(
			file,
			`function second() {
	return 2;
}
`,
		);

		await createInsertBeforeSymbolToolDefinition(dir).execute(
			"call-1",
			{
				path: "sample.ts",
				symbol: "second",
				content: "function first() {\n\treturn 1;\n}",
			},
			undefined,
			undefined,
			testContext,
		);
		await createInsertAfterSymbolToolDefinition(dir).execute(
			"call-2",
			{
				path: "sample.ts",
				symbol: "second",
				content: "function third() {\n\treturn 3;\n}",
			},
			undefined,
			undefined,
			testContext,
		);

		expect(readFileSync(file, "utf-8")).toBe(`function first() {
	return 1;
}
function second() {
	return 2;
}
function third() {
	return 3;
}
`);
	});

	it("renames exact code identifiers across project source files", async () => {
		const dir = makeDir();
		const a = path.join(dir, "a.ts");
		const b = path.join(dir, "b.ts");
		writeFileSync(a, "export function oldName() { return 1; }\n");
		writeFileSync(
			b,
			"import { oldName } from './a';\n" +
				"const value = oldName();\n" +
				"const templated = `$" +
				"{oldName()}`;\n" +
				"const pattern = /oldName/;\n" +
				"const oldNameExtra = 2;\n" +
				"const text = 'oldName';\n" +
				"// oldName comment\n",
		);

		await createRenameSymbolToolDefinition(dir).execute(
			"call-1",
			{
				path: "a.ts",
				symbol: "oldName",
				newName: "newName",
			},
			undefined,
			undefined,
			testContext,
		);

		expect(readFileSync(a, "utf-8")).toContain("function newName()");
		const renamed = readFileSync(b, "utf-8");
		expect(renamed).toContain("import { newName }");
		expect(renamed).toContain("const value = newName();");
		expect(renamed).toContain("const templated = `$" + "{newName()}`;");
		expect(renamed).toContain("const pattern = /oldName/;");
		expect(renamed).toContain("oldNameExtra");
		expect(renamed).toContain("const text = 'oldName';");
		expect(renamed).toContain("// oldName comment");
	});

	it("rolls back project rename if a later file write fails", async () => {
		const dir = makeDir();
		const a = path.join(dir, "a.ts");
		const b = path.join(dir, "b.ts");
		writeFileSync(a, "export function oldName() { return 1; }\n");
		writeFileSync(b, "oldName();\n");
		const originalA = readFileSync(a, "utf-8");
		let writes = 0;
		const options = {
			operations: {
				readFile: (absolutePath: string) => readFileSync(absolutePath, "utf-8"),
				writeFile: (absolutePath: string, content: string) => {
					writes++;
					if (absolutePath === b) throw new Error("simulated write failure");
					writeFileSync(absolutePath, content, "utf-8");
				},
				listSourceFiles: () => [a, b],
			},
		};

		await expect(
			createRenameSymbolToolDefinition(dir, options).execute(
				"call-1",
				{ path: "a.ts", symbol: "oldName", newName: "newName" },
				undefined,
				undefined,
				testContext,
			),
		).rejects.toThrow(/simulated write failure/);
		expect(writes).toBeGreaterThanOrEqual(3);
		expect(readFileSync(a, "utf-8")).toBe(originalA);
	});

	it("refuses project-wide symbol mutations when the source file scan is capped", async () => {
		const dir = makeDir();
		const file = path.join(dir, "a.ts");
		writeFileSync(file, "export function target() { return 1; }\n");
		const tooManyFiles = Array.from({ length: 5001 }, (_, index) => path.join(dir, `${index}.ts`));
		const options = { operations: { listSourceFiles: () => tooManyFiles } };

		await expect(
			createRenameSymbolToolDefinition(dir, options).execute(
				"call-1",
				{ path: "a.ts", symbol: "target", newName: "renamed" },
				undefined,
				undefined,
				testContext,
			),
		).rejects.toThrow(/more than 5000 source files/);
		await expect(
			createSafeDeleteSymbolToolDefinition(dir, options).execute(
				"call-2",
				{ path: "a.ts", symbol: "target" },
				undefined,
				undefined,
				testContext,
			),
		).rejects.toThrow(/more than 5000 source files/);
	});

	it("keeps leading docs and decorators attached to symbol operations", async () => {
		const dir = makeDir();
		const file = path.join(dir, "sample.ts");
		writeFileSync(
			file,
			`/** Describes decorated */
@sealed
export class Decorated {
}
`,
		);

		await createInsertBeforeSymbolToolDefinition(dir).execute(
			"call-1",
			{
				path: "sample.ts",
				symbol: "Decorated",
				content: "export class Before {}",
			},
			undefined,
			undefined,
			testContext,
		);
		expect(readFileSync(file, "utf-8")).toBe(`export class Before {}
/** Describes decorated */
@sealed
export class Decorated {
}
`);

		await createSafeDeleteSymbolToolDefinition(dir).execute(
			"call-2",
			{ path: "sample.ts", symbol: "Decorated", scope: "file" },
			undefined,
			undefined,
			testContext,
		);
		expect(readFileSync(file, "utf-8")).toBe("export class Before {}\n");
	});

	it("ignores comments and strings during safe-delete reference checks", async () => {
		const dir = makeDir();
		const a = path.join(dir, "a.ts");
		const b = path.join(dir, "b.ts");
		writeFileSync(a, "export function unused() { return 1; }\n");
		writeFileSync(
			b,
			"const text = 'unused';\nfunction matcher() { return /unused/.test(text); }\n// unused is mentioned only in a comment\n",
		);

		await createSafeDeleteSymbolToolDefinition(dir).execute(
			"call-1",
			{ path: "a.ts", symbol: "unused" },
			undefined,
			undefined,
			testContext,
		);
		expect(readFileSync(a, "utf-8")).toBe("");
	});

	it("refuses safe deletion for references inside template interpolations", async () => {
		const dir = makeDir();
		const a = path.join(dir, "a.ts");
		const b = path.join(dir, "b.ts");
		writeFileSync(a, "export function used() { return 1; }\n");
		writeFileSync(b, "const text = `$" + "{used()}`;\n");

		await expect(
			createSafeDeleteSymbolToolDefinition(dir).execute(
				"call-1",
				{ path: "a.ts", symbol: "used" },
				undefined,
				undefined,
				testContext,
			),
		).rejects.toThrow(/Refusing to delete used/);
	});

	it("refuses safe deletion while external references remain", async () => {
		const dir = makeDir();
		const a = path.join(dir, "a.ts");
		const b = path.join(dir, "b.ts");
		writeFileSync(a, "export function used() { return 1; }\n");
		writeFileSync(b, "import { used } from './a';\nconsole.log(used());\n");

		const tool = createSafeDeleteSymbolToolDefinition(dir);
		await expect(
			tool.execute("call-1", { path: "a.ts", symbol: "used" }, undefined, undefined, testContext),
		).rejects.toThrow(/Refusing to delete used/);

		await tool.execute("call-2", { path: "a.ts", symbol: "used", force: true }, undefined, undefined, testContext);
		expect(readFileSync(a, "utf-8")).toBe("");
	});
});
