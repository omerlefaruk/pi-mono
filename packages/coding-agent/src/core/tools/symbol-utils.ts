import path from "node:path";
import { globSync } from "glob";

export type SymbolKind = "class" | "function" | "method" | "variable" | "interface" | "enum" | "type" | "struct";

export interface CodeSymbol {
	name: string;
	fullName: string;
	kind: SymbolKind;
	startLine: number;
	endLine: number;
	startOffset: number;
	endOffset: number;
	bodyStartOffset?: number;
	bodyEndOffset?: number;
	openBraceOffset?: number;
	closeBraceOffset?: number;
	indent: string;
	parentFullName?: string;
}

export interface SymbolReference {
	path: string;
	line: number;
	column: number;
	text: string;
}

const CONTROL_WORDS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"with",
	"return",
	"throw",
	"else",
	"do",
	"try",
	"finally",
	"new",
]);

const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".cts",
	".mjs",
	".cjs",
	".py",
	".rs",
	".go",
	".java",
	".kt",
	".kts",
	".cs",
	".cpp",
	".cc",
	".cxx",
	".c",
	".h",
	".hpp",
	".hh",
]);

const DEFAULT_IGNORE = [
	"**/.git/**",
	"**/node_modules/**",
	"**/dist/**",
	"**/build/**",
	"**/coverage/**",
	"**/.next/**",
	"**/.turbo/**",
	"**/.cache/**",
	"**/target/**",
	"**/__pycache__/**",
];

export function isSourcePath(filePath: string): boolean {
	return SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function detectEol(content: string): "\r\n" | "\n" {
	return content.includes("\r\n") ? "\r\n" : "\n";
}

export function normalizeToLf(content: string): string {
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreEol(content: string, eol: "\r\n" | "\n"): string {
	return eol === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

function getLineStarts(content: string): number[] {
	const starts = [0];
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\n") starts.push(i + 1);
	}
	return starts;
}

function lineToOffset(lineStarts: number[], line: number): number {
	return lineStarts[Math.max(0, Math.min(line - 1, lineStarts.length - 1))] ?? 0;
}

function offsetToLine(lineStarts: number[], offset: number): number {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		if (lineStarts[mid] <= offset) low = mid + 1;
		else high = mid - 1;
	}
	return Math.max(1, high + 1);
}

function getLineEnd(content: string, lineStarts: number[], line: number): number {
	const next = lineStarts[line];
	if (next === undefined) return content.length;
	return content[next - 1] === "\n" ? next - 1 : next;
}

function indentation(line: string): string {
	return line.match(/^\s*/)?.[0] ?? "";
}

function isLeadingDecoratorOrAttribute(trimmed: string): boolean {
	return trimmed.startsWith("@") || /^\[[A-Za-z_][\w.()\]",\s]*\]$/.test(trimmed);
}

function isLeadingLineComment(trimmed: string): boolean {
	return trimmed.startsWith("//") || trimmed.startsWith("#");
}

function leadingStartIndex(lines: string[], declarationIndex: number): number {
	let start = declarationIndex;
	let index = declarationIndex - 1;
	while (index >= 0) {
		const trimmed = lines[index].trim();
		if (trimmed === "") break;
		if (isLeadingDecoratorOrAttribute(trimmed) || isLeadingLineComment(trimmed)) {
			start = index;
			index--;
			continue;
		}
		if (trimmed.endsWith("*/")) {
			let commentStart = index;
			while (commentStart >= 0 && !lines[commentStart].includes("/*")) commentStart--;
			if (commentStart < 0) break;
			start = commentStart;
			index = commentStart - 1;
			continue;
		}
		break;
	}
	return start;
}

function declarationEndLineForPython(lines: string[], startLine: number, startIndent: string): number {
	const startIndentSize = startIndent.length;
	for (let i = startLine; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "") continue;
		const lineIndentSize = indentation(line).length;
		if (lineIndentSize <= startIndentSize) return i;
	}
	return lines.length;
}

function findOpeningBrace(content: string, startOffset: number): number | undefined {
	let quote: '"' | "'" | "`" | undefined;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	let parenDepth = 0;
	let bracketDepth = 0;

	for (let i = startOffset; i < content.length; i++) {
		const ch = content[i];
		const next = content[i + 1];
		if (lineComment) {
			if (ch === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (ch === "*" && next === "/") {
				blockComment = false;
				i++;
			}
			continue;
		}
		if (quote) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "/" && next === "/") {
			lineComment = true;
			i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			blockComment = true;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "(") parenDepth++;
		else if (ch === ")" && parenDepth > 0) parenDepth--;
		else if (ch === "[") bracketDepth++;
		else if (ch === "]" && bracketDepth > 0) bracketDepth--;
		if (ch === "{") {
			if (parenDepth === 0 && bracketDepth === 0) {
				const previous = previousSignificantChar(content, i);
				if (previous?.ch !== ":" && wordEndingAt(content, previous?.index ?? -1) !== "extends") return i;
			}
			const close = findMatchingBrace(content, i);
			if (close !== undefined) {
				i = close;
				continue;
			}
		}
		if (ch === ";" && parenDepth === 0 && bracketDepth === 0) return undefined;
		if (ch === "\n" && parenDepth === 0 && bracketDepth === 0) {
			// Keep scanning a few declaration lines for wrapped signatures.
			const lookahead = content.slice(startOffset, i + 1).split("\n").length;
			if (lookahead > 8) return undefined;
		}
	}
	return undefined;
}

function findMatchingBrace(content: string, openOffset: number): number | undefined {
	let depth = 0;
	let quote: '"' | "'" | "`" | undefined;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let i = openOffset; i < content.length; i++) {
		const ch = content[i];
		const next = content[i + 1];
		if (lineComment) {
			if (ch === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (ch === "*" && next === "/") {
				blockComment = false;
				i++;
			}
			continue;
		}
		if (quote) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === quote) {
				quote = undefined;
			}
			continue;
		}
		if (ch === "/" && next === "/") {
			lineComment = true;
			i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			blockComment = true;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "{") depth++;
		if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return undefined;
}

function detectSymbolOnLine(line: string, filePath: string): { name: string; kind: SymbolKind } | undefined {
	const ext = path.extname(filePath).toLowerCase();
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) return undefined;

	if (ext === ".py") {
		const python = line.match(/^\s*(?:async\s+def|def|class)\s+([A-Za-z_][\w]*)\b/);
		if (python) return { name: python[1], kind: trimmed.startsWith("class ") ? "class" : "function" };
		return undefined;
	}

	const classLike = line.match(
		/^\s*(?:export\s+default\s+|export\s+)?(?:(?:abstract|final|public|private|protected|static|sealed|partial)\s+)*(class|interface|enum|struct|trait)\s+([A-Za-z_$][\w$]*)\b/,
	);
	if (classLike) {
		const rawKind = classLike[1];
		const kind: SymbolKind =
			rawKind === "struct"
				? "struct"
				: rawKind === "interface"
					? "interface"
					: rawKind === "enum"
						? "enum"
						: "class";
		return { name: classLike[2], kind };
	}

	const typeAlias = line.match(/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/);
	if (typeAlias) return { name: typeAlias[1], kind: "type" };

	const functionDecl = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\b/);
	if (functionDecl) return { name: functionDecl[1], kind: "function" };

	const arrowDecl = line.match(
		/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
	);
	if (arrowDecl) return { name: arrowDecl[1], kind: "function" };

	const goFunc = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/);
	if (goFunc) return { name: goFunc[1], kind: "function" };

	const rustFn = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*[<(]/);
	if (rustFn) return { name: rustFn[1], kind: "function" };

	const method = line.match(
		/^\s*(?:(?:public|private|protected|static|async|get|set|override|readonly|virtual|final|abstract|sealed)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\).*\{/,
	);
	if (method && !CONTROL_WORDS.has(method[1])) return { name: method[1], kind: "method" };

	const typedMethod = line.match(
		/^\s*(?:(?:public|private|protected|static|async|override|virtual|final|abstract|sealed)\s+)+[A-Za-z_$][\w$<>,[\].?\s]*\s+([A-Za-z_$][\w$]*)\s*\([^)]*\).*\{/,
	);
	if (typedMethod && !CONTROL_WORDS.has(typedMethod[1])) return { name: typedMethod[1], kind: "method" };

	return undefined;
}

function withParentNames(symbols: CodeSymbol[]): CodeSymbol[] {
	return symbols.map((symbol) => {
		const parents = symbols
			.filter(
				(candidate) =>
					candidate !== symbol &&
					candidate.startLine <= symbol.startLine &&
					candidate.endLine >= symbol.endLine &&
					(candidate.startLine !== symbol.startLine || candidate.endLine !== symbol.endLine),
			)
			.sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine));
		const parent = parents[0];
		return {
			...symbol,
			parentFullName: parent?.fullName,
			fullName: parent ? `${parent.fullName}.${symbol.name}` : symbol.name,
		};
	});
}

export function parseSymbols(content: string, filePath: string): CodeSymbol[] {
	const normalized = normalizeToLf(content);
	const lines = normalized.split("\n");
	const lineStarts = getLineStarts(normalized);
	const symbols: CodeSymbol[] = [];
	const ext = path.extname(filePath).toLowerCase();

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const detected = detectSymbolOnLine(line, filePath);
		if (!detected) continue;

		const leadingIndex = leadingStartIndex(lines, index);
		const startLine = leadingIndex + 1;
		const declarationLine = index + 1;
		const startOffset = lineToOffset(lineStarts, startLine);
		const indent = indentation(line);
		let endLine: number;
		let endOffset: number;
		let bodyStartOffset: number | undefined;
		let bodyEndOffset: number | undefined;
		let openBraceOffset: number | undefined;
		let closeBraceOffset: number | undefined;

		if (ext === ".py") {
			endLine = declarationEndLineForPython(lines, declarationLine, indent);
			endOffset = getLineEnd(normalized, lineStarts, endLine);
			if (endLine < lines.length) endOffset = lineToOffset(lineStarts, endLine + 1);
			bodyStartOffset = lineToOffset(lineStarts, Math.min(declarationLine + 1, lines.length));
			bodyEndOffset = endOffset;
		} else {
			openBraceOffset = findOpeningBrace(normalized, lineToOffset(lineStarts, declarationLine));
			closeBraceOffset = openBraceOffset === undefined ? undefined : findMatchingBrace(normalized, openBraceOffset);
			if (closeBraceOffset !== undefined) {
				endLine = offsetToLine(lineStarts, closeBraceOffset);
				const nextLineOffset = lineToOffset(lineStarts, endLine + 1);
				endOffset = nextLineOffset > lineToOffset(lineStarts, endLine) ? nextLineOffset : normalized.length;
				bodyStartOffset = openBraceOffset === undefined ? undefined : openBraceOffset + 1;
				bodyEndOffset = closeBraceOffset;
			} else {
				endLine = startLine;
				endOffset = getLineEnd(normalized, lineStarts, startLine);
			}
		}

		symbols.push({
			name: detected.name,
			fullName: detected.name,
			kind: detected.kind,
			startLine,
			endLine,
			startOffset,
			endOffset,
			bodyStartOffset,
			bodyEndOffset,
			openBraceOffset,
			closeBraceOffset,
			indent,
		});
	}

	return withParentNames(symbols).sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

export function findSymbol(symbols: CodeSymbol[], symbolName: string): CodeSymbol {
	const matches = symbols.filter((symbol) => symbol.fullName === symbolName || symbol.name === symbolName);
	if (matches.length === 0) throw new Error(`Symbol not found: ${symbolName}`);
	if (matches.length > 1) {
		const choices = matches
			.map((symbol) => `${symbol.fullName} (${symbol.kind}, lines ${symbol.startLine}-${symbol.endLine})`)
			.join("; ");
		throw new Error(`Ambiguous symbol ${symbolName}. Use a fully qualified name. Matches: ${choices}`);
	}
	return matches[0];
}

export function formatSymbolOverview(filePath: string, symbols: CodeSymbol[]): string {
	if (symbols.length === 0) return `${filePath}: no symbols found`;
	const lines = [`${filePath}: ${symbols.length} symbol${symbols.length === 1 ? "" : "s"}`];
	for (const symbol of symbols) {
		const depth = symbol.fullName.split(".").length - 1;
		const prefix = "  ".repeat(depth);
		lines.push(`${prefix}${symbol.fullName} [${symbol.kind}] lines ${symbol.startLine}-${symbol.endLine}`);
	}
	return lines.join("\n");
}

export function commonIndent(lines: string[]): string {
	let common: string | undefined;
	for (const line of lines) {
		if (line.trim() === "") continue;
		const current = indentation(line);
		if (common === undefined) {
			common = current;
			continue;
		}
		let i = 0;
		while (i < common.length && i < current.length && common[i] === current[i]) i++;
		common = common.slice(0, i);
	}
	return common ?? "";
}

export function indentBlock(text: string, indent: string): string {
	const normalized = normalizeToLf(text).replace(/^\n+|\n+$/g, "");
	if (normalized.length === 0) return indent;
	const lines = normalized.split("\n");
	const base = commonIndent(lines);
	return lines.map((line) => (line.trim() === "" ? "" : indent + line.slice(base.length))).join("\n");
}

export function childIndentForSymbol(content: string, symbol: CodeSymbol): string {
	const fallbackIndent = content.includes("\t") ? `${symbol.indent}\t` : `${symbol.indent}    `;
	if (symbol.bodyStartOffset === undefined || symbol.bodyEndOffset === undefined) return fallbackIndent;
	const body = content.slice(symbol.bodyStartOffset, symbol.bodyEndOffset);
	const bodyLines = body.split("\n");
	for (const line of bodyLines) {
		if (line.trim() !== "") return indentation(line);
	}
	return fallbackIndent;
}

export function replaceRange(content: string, start: number, end: number, replacement: string): string {
	return content.slice(0, start) + replacement + content.slice(end);
}

export function isValidIdentifier(name: string): boolean {
	return /^[A-Za-z_$][\w$]*$/.test(name);
}

function isIdentifierPart(ch: string | undefined): boolean {
	return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

function usesHashComments(filePath: string): boolean {
	return path.extname(filePath).toLowerCase() === ".py";
}

function previousSignificantChar(content: string, index: number): { ch: string; index: number } | undefined {
	for (let cursor = index - 1; cursor >= 0; cursor--) {
		const ch = content[cursor];
		if (!/\s/.test(ch)) return { ch, index: cursor };
	}
	return undefined;
}

function wordEndingAt(content: string, index: number): string {
	let start = index;
	while (start >= 0 && isIdentifierPart(content[start])) start--;
	return content.slice(start + 1, index + 1);
}

function isRegexStart(content: string, index: number): boolean {
	const previous = previousSignificantChar(content, index);
	if (previous === undefined) return true;
	if ("([{,:;=!?&|+-*~^<>%".includes(previous.ch)) return true;
	if (isIdentifierPart(previous.ch)) {
		return new Set(["return", "throw", "case", "delete", "typeof", "void", "yield", "await"]).has(
			wordEndingAt(content, previous.index),
		);
	}
	return false;
}

function skipQuoted(content: string, index: number, quote: '"' | "'"): number {
	let escaped = false;
	for (let cursor = index + 1; cursor < content.length; cursor++) {
		const ch = content[cursor];
		if (escaped) escaped = false;
		else if (ch === "\\") escaped = true;
		else if (ch === quote) return cursor;
	}
	return content.length - 1;
}

function skipRegexLiteral(content: string, index: number): number {
	let escaped = false;
	let inClass = false;
	for (let cursor = index + 1; cursor < content.length; cursor++) {
		const ch = content[cursor];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "[") inClass = true;
		else if (ch === "]") inClass = false;
		else if (ch === "/" && !inClass) {
			while (/[A-Za-z]/.test(content[cursor + 1] ?? "")) cursor++;
			return cursor;
		}
		if (ch === "\n") return cursor - 1;
	}
	return content.length - 1;
}

function findTemplateExpressionEnd(content: string, openBrace: number): number {
	let depth = 1;
	for (let cursor = openBrace + 1; cursor < content.length; cursor++) {
		const ch = content[cursor];
		const next = content[cursor + 1];
		if (ch === '"' || ch === "'") {
			cursor = skipQuoted(content, cursor, ch);
			continue;
		}
		if (ch === "`") {
			cursor = skipTemplateLiteral(content, cursor, () => undefined);
			continue;
		}
		if (ch === "/" && next === "/") {
			const end = content.indexOf("\n", cursor + 2);
			cursor = end === -1 ? content.length : end;
			continue;
		}
		if (ch === "/" && next === "*") {
			const end = content.indexOf("*/", cursor + 2);
			cursor = end === -1 ? content.length : end + 1;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return cursor;
		}
	}
	return content.length - 1;
}

function skipTemplateLiteral(
	content: string,
	index: number,
	visitExpression: (start: number, end: number) => void,
): number {
	let escaped = false;
	for (let cursor = index + 1; cursor < content.length; cursor++) {
		const ch = content[cursor];
		const next = content[cursor + 1];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "`") return cursor;
		if (ch === "$" && next === "{") {
			const end = findTemplateExpressionEnd(content, cursor + 1);
			visitExpression(cursor + 2, end);
			cursor = end;
		}
	}
	return content.length - 1;
}

function collectIdentifierOffsetsInCode(
	content: string,
	name: string,
	filePath: string,
	start: number,
	end: number,
	offsets: number[],
): void {
	const hashComments = usesHashComments(filePath);
	for (let index = start; index < end; index++) {
		const ch = content[index];
		const next = content[index + 1];
		if (ch === "/" && next === "/") {
			const lineEnd = content.indexOf("\n", index + 2);
			index = lineEnd === -1 ? end : lineEnd;
			continue;
		}
		if (ch === "/" && next === "*") {
			const commentEnd = content.indexOf("*/", index + 2);
			index = commentEnd === -1 ? end : commentEnd + 1;
			continue;
		}
		if (hashComments && ch === "#") {
			const lineEnd = content.indexOf("\n", index + 1);
			index = lineEnd === -1 ? end : lineEnd;
			continue;
		}
		if (hashComments && (content.startsWith('"""', index) || content.startsWith("'''", index))) {
			const delimiter = content.slice(index, index + 3);
			const quoteEnd = content.indexOf(delimiter, index + 3);
			index = quoteEnd === -1 ? end : quoteEnd + 2;
			continue;
		}
		if (ch === '"' || ch === "'") {
			index = skipQuoted(content, index, ch);
			continue;
		}
		if (ch === "`") {
			index = skipTemplateLiteral(content, index, (expressionStart, expressionEnd) => {
				collectIdentifierOffsetsInCode(content, name, filePath, expressionStart, expressionEnd, offsets);
			});
			continue;
		}
		if (ch === "/" && isRegexStart(content, index)) {
			index = skipRegexLiteral(content, index);
			continue;
		}
		if (
			content.startsWith(name, index) &&
			!isIdentifierPart(content[index - 1]) &&
			!isIdentifierPart(content[index + name.length])
		) {
			offsets.push(index);
			index += name.length - 1;
		}
	}
}

function identifierOffsetsInCode(content: string, name: string, filePath: string): number[] {
	const offsets: number[] = [];
	collectIdentifierOffsetsInCode(content, name, filePath, 0, content.length, offsets);
	return offsets.sort((a, b) => a - b);
}

export function replaceIdentifierInCode(content: string, name: string, replacement: string, filePath: string): string {
	const offsets = identifierOffsetsInCode(content, name, filePath);
	if (offsets.length === 0) return content;
	let result = "";
	let cursor = 0;
	for (const offset of offsets) {
		result += content.slice(cursor, offset) + replacement;
		cursor = offset + name.length;
	}
	return result + content.slice(cursor);
}

export function listSourceFiles(root: string, scopePath?: string, limit = 5000): string[] {
	const base = scopePath ? path.resolve(root, scopePath) : root;
	const pattern = isSourcePath(base) ? base : path.join(base, "**/*").replace(/\\/g, "/");
	const matches = globSync(pattern, {
		absolute: true,
		nodir: true,
		ignore: DEFAULT_IGNORE,
		windowsPathsNoEscape: true,
	});
	return matches.filter(isSourcePath).slice(0, limit);
}

export function findIdentifierReferences(
	files: string[],
	name: string,
	readFile: (absolutePath: string) => string,
): SymbolReference[] {
	const references: SymbolReference[] = [];
	for (const filePath of files) {
		const content = normalizeToLf(readFile(filePath));
		const lines = content.split("\n");
		const lineStarts = getLineStarts(content);
		for (const offset of identifierOffsetsInCode(content, name, filePath)) {
			const line = offsetToLine(lineStarts, offset);
			references.push({
				path: filePath,
				line,
				column: offset - lineToOffset(lineStarts, line) + 1,
				text: lines[line - 1]?.trim() ?? "",
			});
		}
	}
	return references;
}
