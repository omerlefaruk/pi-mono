import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { resolveReadPath } from "./path-utils.js";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.js";
import {
	type CodeSymbol,
	childIndentForSymbol,
	detectEol,
	findIdentifierReferences,
	findSymbol,
	formatSymbolOverview,
	indentBlock,
	isValidIdentifier,
	listSourceFiles,
	normalizeToLf,
	parseSymbols,
	replaceIdentifierInCode,
	replaceRange,
	restoreEol,
	type SymbolReference,
} from "./symbol-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const symbolOverviewSchema = Type.Object({
	path: Type.String({ description: "File or directory to summarize by symbols (relative or absolute)" }),
	limit: Type.Optional(Type.Number({ description: "Maximum number of files to inspect when path is a directory" })),
});

const readSymbolSchema = Type.Object({
	path: Type.String({ description: "Path to the file containing the symbol" }),
	symbol: Type.String({ description: "Symbol name or fully qualified name, e.g. ClassName.methodName" }),
	bodyOnly: Type.Optional(
		Type.Boolean({ description: "Return only the symbol body instead of the full declaration" }),
	),
});

const symbolBodyEditSchema = Type.Object({
	path: Type.String({ description: "Path to the file containing the symbol" }),
	symbol: Type.String({ description: "Symbol name or fully qualified name, e.g. ClassName.methodName" }),
	body: Type.String({ description: "Replacement body. Do not include the function/class declaration." }),
});

const symbolInsertSchema = Type.Object({
	path: Type.String({ description: "Path to the file containing the anchor symbol" }),
	symbol: Type.String({ description: "Anchor symbol name or fully qualified name" }),
	content: Type.String({ description: "Code to insert before or after the anchor symbol" }),
});

const renameSymbolSchema = Type.Object({
	path: Type.String({ description: "Path to the file containing the symbol declaration" }),
	symbol: Type.String({ description: "Symbol name or fully qualified name to rename" }),
	newName: Type.String({ description: "New identifier name" }),
	scope: Type.Optional(
		Type.Union([Type.Literal("project"), Type.Literal("file")], {
			description: "Rename references in the whole project or only this file (default: project)",
		}),
	),
});

const safeDeleteSymbolSchema = Type.Object({
	path: Type.String({ description: "Path to the file containing the symbol declaration" }),
	symbol: Type.String({ description: "Symbol name or fully qualified name to delete" }),
	scope: Type.Optional(
		Type.Union([Type.Literal("project"), Type.Literal("file")], {
			description: "Check references in the whole project or only this file (default: project)",
		}),
	),
	force: Type.Optional(Type.Boolean({ description: "Delete even if references are found (default: false)" })),
});

export type SymbolOverviewToolInput = Static<typeof symbolOverviewSchema>;
export type ReadSymbolToolInput = Static<typeof readSymbolSchema>;
export type ReplaceSymbolBodyToolInput = Static<typeof symbolBodyEditSchema>;
export type InsertSymbolToolInput = Static<typeof symbolInsertSchema>;
export type RenameSymbolToolInput = Static<typeof renameSymbolSchema>;
export type SafeDeleteSymbolToolInput = Static<typeof safeDeleteSymbolSchema>;

export interface SymbolToolDetails {
	truncation?: TruncationResult;
	symbols?: Array<{ name: string; fullName: string; kind: string; startLine: number; endLine: number }>;
	references?: SymbolReference[];
	filesChanged?: string[];
}

export interface SymbolOperations {
	readFile: (absolutePath: string) => string;
	writeFile: (absolutePath: string, content: string) => void;
	listSourceFiles: (root: string, scopePath?: string, limit?: number) => string[];
}

const PROJECT_SCOPE_FILE_LIMIT = 5000;

const defaultSymbolOperations: SymbolOperations = {
	readFile: (absolutePath) => readFileSync(absolutePath, "utf-8"),
	writeFile: (absolutePath, content) => writeFileSync(absolutePath, content, "utf-8"),
	listSourceFiles,
};

export interface SymbolToolOptions {
	operations?: Partial<SymbolOperations>;
}

function getOps(options?: SymbolToolOptions): SymbolOperations {
	return { ...defaultSymbolOperations, ...options?.operations };
}

function summarizeSymbol(symbol: CodeSymbol): {
	name: string;
	fullName: string;
	kind: string;
	startLine: number;
	endLine: number;
} {
	return {
		name: symbol.name,
		fullName: symbol.fullName,
		kind: symbol.kind,
		startLine: symbol.startLine,
		endLine: symbol.endLine,
	};
}

function formatBasicCall(
	toolName: string,
	args: { path?: string; symbol?: string; newName?: string } | undefined,
	theme: Theme,
): string {
	const rawPath = str(args?.path);
	const symbol = str(args?.symbol);
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold(toolName))} ${rawPath === null ? invalidArg : theme.fg("accent", shortenPath(rawPath || "..."))}`;
	if (symbol !== undefined) text += theme.fg("toolOutput", ` ${symbol === null ? "[invalid symbol]" : symbol}`);
	if (args?.newName) text += theme.fg("toolOutput", ` -> ${args.newName}`);
	return text;
}

function formatSymbolTextResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: SymbolToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trimEnd();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 18;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
	}
	if (result.details?.truncation?.truncated) {
		text += `\n${theme.fg("warning", `[Truncated: ${formatSize(result.details.truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
	}
	return text;
}

function readParsedSymbol(
	cwd: string,
	ops: SymbolOperations,
	filePath: string,
	symbolName: string,
): { absolutePath: string; content: string; normalized: string; symbol: CodeSymbol; symbols: CodeSymbol[] } {
	const absolutePath = resolveReadPath(filePath, cwd);
	const content = ops.readFile(absolutePath);
	const normalized = normalizeToLf(content);
	const symbols = parseSymbols(normalized, absolutePath);
	const symbol = findSymbol(symbols, symbolName);
	return { absolutePath, content, normalized, symbol, symbols };
}

function bodySnippet(content: string, symbol: CodeSymbol): string {
	if (symbol.bodyStartOffset === undefined || symbol.bodyEndOffset === undefined) {
		throw new Error(`Symbol ${symbol.fullName} does not have a replaceable body`);
	}
	let snippet = content.slice(symbol.bodyStartOffset, symbol.bodyEndOffset);
	if (symbol.openBraceOffset !== undefined) {
		snippet = snippet.replace(/^\n/, "").replace(/\n[\t ]*$/, "");
	} else {
		snippet = snippet.replace(/\n$/, "");
	}
	return snippet;
}

function formatReplacementBody(content: string, symbol: CodeSymbol, body: string): string {
	const childIndent = childIndentForSymbol(content, symbol);
	if (symbol.openBraceOffset !== undefined) {
		return `\n${indentBlock(body, childIndent)}\n${symbol.indent}`;
	}
	return `${indentBlock(body, childIndent)}\n`;
}

function ensureTrailingNewline(text: string): string {
	const normalized = normalizeToLf(text).replace(/^\n+|\n+$/g, "");
	return normalized.length === 0 ? "" : `${normalized}\n`;
}

function projectFilesForMutation(cwd: string, ops: SymbolOperations): string[] {
	const files = ops.listSourceFiles(cwd, undefined, PROJECT_SCOPE_FILE_LIMIT + 1);
	if (files.length > PROJECT_SCOPE_FILE_LIMIT) {
		throw new Error(
			`Project symbol operation refused: more than ${PROJECT_SCOPE_FILE_LIMIT} source files matched. Use scope: "file" or narrow the working directory so the operation cannot silently skip files.`,
		);
	}
	return files;
}

function referencesForScope(
	cwd: string,
	ops: SymbolOperations,
	absolutePath: string,
	scope: "project" | "file",
	name: string,
): SymbolReference[] {
	const files = scope === "file" ? [absolutePath] : projectFilesForMutation(cwd, ops);
	return findIdentifierReferences(files, name, ops.readFile);
}

function declarationReferences(
	references: SymbolReference[],
	absolutePath: string,
	symbol: CodeSymbol,
): SymbolReference[] {
	const normalizedAbsolutePath = path.resolve(absolutePath);
	return references.filter((reference) => {
		if (path.resolve(reference.path) !== normalizedAbsolutePath) return true;
		return reference.line < symbol.startLine || reference.line > symbol.endLine;
	});
}

export function createSymbolOverviewToolDefinition(
	cwd: string,
	options?: SymbolToolOptions,
): ToolDefinition<typeof symbolOverviewSchema, SymbolToolDetails | undefined> {
	const ops = getOps(options);
	return {
		name: "symbol_overview",
		label: "symbol_overview",
		description: `Return a compact outline of symbols in a file or directory: classes, functions, methods, and line ranges. Use this before reading large files so bodies can be requested on demand. Output is truncated to ${DEFAULT_MAX_BYTES / 1024}KB.`,
		promptSnippet: "Get compact file/package outlines by symbols",
		promptGuidelines: [
			"Use symbol_overview before reading large source files.",
			"Use read_symbol to fetch only the body you need after inspecting an outline.",
		],
		parameters: symbolOverviewSchema,
		async execute(_toolCallId, { path: inputPath, limit }: SymbolOverviewToolInput) {
			const absolutePath = resolveReadPath(inputPath, cwd);
			const files = ops.listSourceFiles(cwd, absolutePath, limit ?? 100);
			const targetFiles = files.length > 0 ? files : [absolutePath];
			const sections: string[] = [];
			const detailsSymbols: SymbolToolDetails["symbols"] = [];
			for (const file of targetFiles) {
				const content = ops.readFile(file);
				const symbols = parseSymbols(content, file);
				sections.push(formatSymbolOverview(path.relative(cwd, file).replace(/\\/g, "/") || file, symbols));
				for (const symbol of symbols) detailsSymbols.push(summarizeSymbol(symbol));
			}
			const rawOutput = sections.join("\n\n");
			const truncation = truncateHead(rawOutput);
			return {
				content: [{ type: "text", text: truncation.content }],
				details: { truncation, symbols: detailsSymbols },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBasicCall("symbol_overview", args, theme));
			return text;
		},
		renderResult(result, renderOptions, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSymbolTextResult(result, renderOptions, theme, context.showImages));
			return text;
		},
	};
}

export function createReadSymbolToolDefinition(
	cwd: string,
	options?: SymbolToolOptions,
): ToolDefinition<typeof readSymbolSchema, SymbolToolDetails | undefined> {
	const ops = getOps(options);
	return {
		name: "read_symbol",
		label: "read_symbol",
		description: `Read one symbol declaration or body from a file by name. Use after symbol_overview to fetch bodies on demand instead of reading entire files. Output is truncated to ${DEFAULT_MAX_BYTES / 1024}KB.`,
		promptSnippet: "Read a single symbol body or declaration on demand",
		promptGuidelines: ["Prefer read_symbol over read when you only need one function, class, or method."],
		parameters: readSymbolSchema,
		async execute(_toolCallId, { path: inputPath, symbol: symbolName, bodyOnly }: ReadSymbolToolInput) {
			const { absolutePath, normalized, symbol } = readParsedSymbol(cwd, ops, inputPath, symbolName);
			const text = bodyOnly
				? bodySnippet(normalized, symbol)
				: normalized.slice(symbol.startOffset, symbol.endOffset).replace(/\n$/, "");
			const header = `${path.relative(cwd, absolutePath).replace(/\\/g, "/") || absolutePath}:${symbol.startLine}-${symbol.endLine} ${symbol.fullName}`;
			const truncation = truncateHead(`${header}\n${text}`);
			return {
				content: [{ type: "text", text: truncation.content }],
				details: { truncation, symbols: [summarizeSymbol(symbol)] },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBasicCall("read_symbol", args, theme));
			return text;
		},
		renderResult(result, renderOptions, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSymbolTextResult(result, renderOptions, theme, context.showImages));
			return text;
		},
	};
}

export function createReplaceSymbolBodyToolDefinition(
	cwd: string,
	options?: SymbolToolOptions,
): ToolDefinition<typeof symbolBodyEditSchema, SymbolToolDetails | undefined> {
	const ops = getOps(options);
	return {
		name: "replace_symbol_body",
		label: "replace_symbol_body",
		description:
			"Replace a function, method, class, or similar symbol body while preserving its declaration. Safer than raw text replacement when changing one symbol.",
		promptSnippet: "Replace a symbol body without matching raw text",
		promptGuidelines: ["Prefer replace_symbol_body over edit when changing one whole function or method body."],
		parameters: symbolBodyEditSchema,
		executionMode: "sequential",
		async execute(_toolCallId, { path: inputPath, symbol: symbolName, body }: ReplaceSymbolBodyToolInput) {
			const { absolutePath, content, normalized, symbol } = readParsedSymbol(cwd, ops, inputPath, symbolName);
			if (symbol.bodyStartOffset === undefined || symbol.bodyEndOffset === undefined) {
				throw new Error(`Symbol ${symbol.fullName} does not have a replaceable body`);
			}
			const eol = detectEol(content);
			const next = replaceRange(
				normalized,
				symbol.bodyStartOffset,
				symbol.bodyEndOffset,
				formatReplacementBody(normalized, symbol, body),
			);
			ops.writeFile(absolutePath, restoreEol(next, eol));
			return {
				content: [{ type: "text", text: `Replaced body of ${symbol.fullName} in ${inputPath}` }],
				details: { symbols: [summarizeSymbol(symbol)], filesChanged: [absolutePath] },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBasicCall("replace_symbol_body", args, theme));
			return text;
		},
		renderResult(result, renderOptions, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSymbolTextResult(result, renderOptions, theme, context.showImages));
			return text;
		},
	};
}

function createInsertSymbolToolDefinition(
	name: "insert_before_symbol" | "insert_after_symbol",
	cwd: string,
	options?: SymbolToolOptions,
): ToolDefinition<typeof symbolInsertSchema, SymbolToolDetails | undefined> {
	const ops = getOps(options);
	const before = name === "insert_before_symbol";
	return {
		name,
		label: name,
		description: `${before ? "Insert code before" : "Insert code after"} a symbol declaration using the parsed symbol range instead of line numbers.`,
		promptSnippet: `${before ? "Insert before" : "Insert after"} a symbol without line-number drift`,
		promptGuidelines: [
			"Prefer insert_before_symbol/insert_after_symbol over line-based insertion around functions, methods, and classes.",
		],
		parameters: symbolInsertSchema,
		executionMode: "sequential",
		async execute(
			_toolCallId,
			{ path: inputPath, symbol: symbolName, content: insertContent }: InsertSymbolToolInput,
		) {
			const { absolutePath, content, normalized, symbol } = readParsedSymbol(cwd, ops, inputPath, symbolName);
			const eol = detectEol(content);
			const insertion = ensureTrailingNewline(insertContent);
			const offset = before ? symbol.startOffset : symbol.endOffset;
			const separator = before ? "" : normalized.slice(Math.max(0, offset - 1), offset) === "\n" ? "" : "\n";
			const next = replaceRange(normalized, offset, offset, before ? insertion : `${separator}${insertion}`);
			ops.writeFile(absolutePath, restoreEol(next, eol));
			return {
				content: [
					{
						type: "text",
						text: `${before ? "Inserted before" : "Inserted after"} ${symbol.fullName} in ${inputPath}`,
					},
				],
				details: { symbols: [summarizeSymbol(symbol)], filesChanged: [absolutePath] },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBasicCall(name, args, theme));
			return text;
		},
		renderResult(result, renderOptions, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSymbolTextResult(result, renderOptions, theme, context.showImages));
			return text;
		},
	};
}

export function createInsertBeforeSymbolToolDefinition(cwd: string, options?: SymbolToolOptions) {
	return createInsertSymbolToolDefinition("insert_before_symbol", cwd, options);
}

export function createInsertAfterSymbolToolDefinition(cwd: string, options?: SymbolToolOptions) {
	return createInsertSymbolToolDefinition("insert_after_symbol", cwd, options);
}

export function createRenameSymbolToolDefinition(
	cwd: string,
	options?: SymbolToolOptions,
): ToolDefinition<typeof renameSymbolSchema, SymbolToolDetails | undefined> {
	const ops = getOps(options);
	return {
		name: "rename_symbol",
		label: "rename_symbol",
		description:
			"Heuristically rename a symbol declaration and identifier-token references in the file or project. Skips comments and string/template literals, and uses identifier boundaries to avoid substring replacements, but is not LSP-perfect.",
		promptSnippet: "Heuristically rename a symbol and code-token references",
		promptGuidelines: [
			"Use rename_symbol for simple identifier renames instead of raw search/replace, but inspect results for semantic edge cases.",
		],
		parameters: renameSymbolSchema,
		executionMode: "sequential",
		async execute(_toolCallId, { path: inputPath, symbol: symbolName, newName, scope }: RenameSymbolToolInput) {
			if (!isValidIdentifier(newName)) throw new Error(`Invalid identifier: ${newName}`);
			const { absolutePath, symbol } = readParsedSymbol(cwd, ops, inputPath, symbolName);
			const effectiveScope = scope ?? "project";
			const files = effectiveScope === "file" ? [absolutePath] : projectFilesForMutation(cwd, ops);
			const changes: Array<{ file: string; original: string; next: string }> = [];
			for (const file of files) {
				const original = ops.readFile(file);
				const eol = detectEol(original);
				const normalized = normalizeToLf(original);
				const next = replaceIdentifierInCode(normalized, symbol.name, newName, file);
				if (next !== normalized) changes.push({ file, original, next: restoreEol(next, eol) });
			}
			const changed: string[] = [];
			try {
				for (const change of changes) {
					ops.writeFile(change.file, change.next);
					changed.push(change.file);
				}
			} catch (error) {
				for (const change of changes.slice(0, changed.length).reverse()) {
					try {
						ops.writeFile(change.file, change.original);
					} catch {}
				}
				throw error;
			}
			return {
				content: [
					{
						type: "text",
						text: `Renamed ${symbol.name} to ${newName} in ${changed.length} file${changed.length === 1 ? "" : "s"}`,
					},
				],
				details: { symbols: [summarizeSymbol(symbol)], filesChanged: changed },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBasicCall("rename_symbol", args, theme));
			return text;
		},
		renderResult(result, renderOptions, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSymbolTextResult(result, renderOptions, theme, context.showImages));
			return text;
		},
	};
}

export function createSafeDeleteSymbolToolDefinition(
	cwd: string,
	options?: SymbolToolOptions,
): ToolDefinition<typeof safeDeleteSymbolSchema, SymbolToolDetails | undefined> {
	const ops = getOps(options);
	return {
		name: "safe_delete_symbol",
		label: "safe_delete_symbol",
		description:
			"Delete a symbol after a heuristic code-token reference check. Skips comments and string/template literals; without force, refuses deletion if references remain outside the symbol body.",
		promptSnippet: "Delete a symbol with a heuristic reference check",
		promptGuidelines: [
			"Use safe_delete_symbol instead of raw deletion when removing functions, methods, or classes.",
		],
		parameters: safeDeleteSymbolSchema,
		executionMode: "sequential",
		async execute(_toolCallId, { path: inputPath, symbol: symbolName, scope, force }: SafeDeleteSymbolToolInput) {
			const { absolutePath, content, normalized, symbol } = readParsedSymbol(cwd, ops, inputPath, symbolName);
			const effectiveScope = scope ?? "project";
			const references = declarationReferences(
				referencesForScope(cwd, ops, absolutePath, effectiveScope, symbol.name),
				absolutePath,
				symbol,
			);
			if (references.length > 0 && !force) {
				const preview = references
					.slice(0, 20)
					.map(
						(reference) =>
							`${path.relative(cwd, reference.path).replace(/\\/g, "/")}:${reference.line}:${reference.column}: ${reference.text}`,
					);
				const more =
					references.length > preview.length ? `\n... ${references.length - preview.length} more references` : "";
				throw new Error(
					`Refusing to delete ${symbol.fullName}; ${references.length} reference${references.length === 1 ? "" : "s"} found:\n${preview.join("\n")}${more}`,
				);
			}
			const eol = detectEol(content);
			let deleteEnd = symbol.endOffset;
			if (normalized[deleteEnd] === "\n") deleteEnd++;
			const next = replaceRange(normalized, symbol.startOffset, deleteEnd, "");
			ops.writeFile(absolutePath, restoreEol(next, eol));
			return {
				content: [
					{
						type: "text",
						text: `Deleted ${symbol.fullName} from ${inputPath}${references.length > 0 ? ` with force despite ${references.length} reference${references.length === 1 ? "" : "s"}` : ""}`,
					},
				],
				details: { symbols: [summarizeSymbol(symbol)], references, filesChanged: [absolutePath] },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBasicCall("safe_delete_symbol", args, theme));
			return text;
		},
		renderResult(result, renderOptions, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSymbolTextResult(result, renderOptions, theme, context.showImages));
			return text;
		},
	};
}

export function createSymbolOverviewTool(
	cwd: string,
	options?: SymbolToolOptions,
): AgentTool<typeof symbolOverviewSchema> {
	return wrapToolDefinition(createSymbolOverviewToolDefinition(cwd, options));
}

export function createReadSymbolTool(cwd: string, options?: SymbolToolOptions): AgentTool<typeof readSymbolSchema> {
	return wrapToolDefinition(createReadSymbolToolDefinition(cwd, options));
}

export function createReplaceSymbolBodyTool(
	cwd: string,
	options?: SymbolToolOptions,
): AgentTool<typeof symbolBodyEditSchema> {
	return wrapToolDefinition(createReplaceSymbolBodyToolDefinition(cwd, options));
}

export function createInsertBeforeSymbolTool(
	cwd: string,
	options?: SymbolToolOptions,
): AgentTool<typeof symbolInsertSchema> {
	return wrapToolDefinition(createInsertBeforeSymbolToolDefinition(cwd, options));
}

export function createInsertAfterSymbolTool(
	cwd: string,
	options?: SymbolToolOptions,
): AgentTool<typeof symbolInsertSchema> {
	return wrapToolDefinition(createInsertAfterSymbolToolDefinition(cwd, options));
}

export function createRenameSymbolTool(cwd: string, options?: SymbolToolOptions): AgentTool<typeof renameSymbolSchema> {
	return wrapToolDefinition(createRenameSymbolToolDefinition(cwd, options));
}

export function createSafeDeleteSymbolTool(
	cwd: string,
	options?: SymbolToolOptions,
): AgentTool<typeof safeDeleteSymbolSchema> {
	return wrapToolDefinition(createSafeDeleteSymbolToolDefinition(cwd, options));
}
