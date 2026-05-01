export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.js";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.js";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.js";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.js";
export {
	createInsertAfterSymbolTool,
	createInsertAfterSymbolToolDefinition,
	createInsertBeforeSymbolTool,
	createInsertBeforeSymbolToolDefinition,
	createReadSymbolTool,
	createReadSymbolToolDefinition,
	createRenameSymbolTool,
	createRenameSymbolToolDefinition,
	createReplaceSymbolBodyTool,
	createReplaceSymbolBodyToolDefinition,
	createSafeDeleteSymbolTool,
	createSafeDeleteSymbolToolDefinition,
	createSymbolOverviewTool,
	createSymbolOverviewToolDefinition,
	type InsertSymbolToolInput,
	type ReadSymbolToolInput,
	type RenameSymbolToolInput,
	type ReplaceSymbolBodyToolInput,
	type SafeDeleteSymbolToolInput,
	type SymbolOperations,
	type SymbolOverviewToolInput,
	type SymbolToolDetails,
	type SymbolToolOptions,
} from "./symbol-tools.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.js";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.js";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.js";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.js";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.js";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.js";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.js";
import {
	createInsertAfterSymbolTool,
	createInsertAfterSymbolToolDefinition,
	createInsertBeforeSymbolTool,
	createInsertBeforeSymbolToolDefinition,
	createReadSymbolTool,
	createReadSymbolToolDefinition,
	createRenameSymbolTool,
	createRenameSymbolToolDefinition,
	createReplaceSymbolBodyTool,
	createReplaceSymbolBodyToolDefinition,
	createSafeDeleteSymbolTool,
	createSafeDeleteSymbolToolDefinition,
	createSymbolOverviewTool,
	createSymbolOverviewToolDefinition,
	type SymbolToolOptions,
} from "./symbol-tools.js";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "symbol_overview"
	| "read_symbol"
	| "replace_symbol_body"
	| "insert_before_symbol"
	| "insert_after_symbol"
	| "rename_symbol"
	| "safe_delete_symbol";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"symbol_overview",
	"read_symbol",
	"replace_symbol_body",
	"insert_before_symbol",
	"insert_after_symbol",
	"rename_symbol",
	"safe_delete_symbol",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	symbol?: SymbolToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "symbol_overview":
			return createSymbolOverviewToolDefinition(cwd, options?.symbol);
		case "read_symbol":
			return createReadSymbolToolDefinition(cwd, options?.symbol);
		case "replace_symbol_body":
			return createReplaceSymbolBodyToolDefinition(cwd, options?.symbol);
		case "insert_before_symbol":
			return createInsertBeforeSymbolToolDefinition(cwd, options?.symbol);
		case "insert_after_symbol":
			return createInsertAfterSymbolToolDefinition(cwd, options?.symbol);
		case "rename_symbol":
			return createRenameSymbolToolDefinition(cwd, options?.symbol);
		case "safe_delete_symbol":
			return createSafeDeleteSymbolToolDefinition(cwd, options?.symbol);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "symbol_overview":
			return createSymbolOverviewTool(cwd, options?.symbol);
		case "read_symbol":
			return createReadSymbolTool(cwd, options?.symbol);
		case "replace_symbol_body":
			return createReplaceSymbolBodyTool(cwd, options?.symbol);
		case "insert_before_symbol":
			return createInsertBeforeSymbolTool(cwd, options?.symbol);
		case "insert_after_symbol":
			return createInsertAfterSymbolTool(cwd, options?.symbol);
		case "rename_symbol":
			return createRenameSymbolTool(cwd, options?.symbol);
		case "safe_delete_symbol":
			return createSafeDeleteSymbolTool(cwd, options?.symbol);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
		createSymbolOverviewToolDefinition(cwd, options?.symbol),
		createReadSymbolToolDefinition(cwd, options?.symbol),
		createReplaceSymbolBodyToolDefinition(cwd, options?.symbol),
		createInsertBeforeSymbolToolDefinition(cwd, options?.symbol),
		createInsertAfterSymbolToolDefinition(cwd, options?.symbol),
		createRenameSymbolToolDefinition(cwd, options?.symbol),
		createSafeDeleteSymbolToolDefinition(cwd, options?.symbol),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		symbol_overview: createSymbolOverviewToolDefinition(cwd, options?.symbol),
		read_symbol: createReadSymbolToolDefinition(cwd, options?.symbol),
		replace_symbol_body: createReplaceSymbolBodyToolDefinition(cwd, options?.symbol),
		insert_before_symbol: createInsertBeforeSymbolToolDefinition(cwd, options?.symbol),
		insert_after_symbol: createInsertAfterSymbolToolDefinition(cwd, options?.symbol),
		rename_symbol: createRenameSymbolToolDefinition(cwd, options?.symbol),
		safe_delete_symbol: createSafeDeleteSymbolToolDefinition(cwd, options?.symbol),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
		createSymbolOverviewTool(cwd, options?.symbol),
		createReadSymbolTool(cwd, options?.symbol),
		createReplaceSymbolBodyTool(cwd, options?.symbol),
		createInsertBeforeSymbolTool(cwd, options?.symbol),
		createInsertAfterSymbolTool(cwd, options?.symbol),
		createRenameSymbolTool(cwd, options?.symbol),
		createSafeDeleteSymbolTool(cwd, options?.symbol),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		symbol_overview: createSymbolOverviewTool(cwd, options?.symbol),
		read_symbol: createReadSymbolTool(cwd, options?.symbol),
		replace_symbol_body: createReplaceSymbolBodyTool(cwd, options?.symbol),
		insert_before_symbol: createInsertBeforeSymbolTool(cwd, options?.symbol),
		insert_after_symbol: createInsertAfterSymbolTool(cwd, options?.symbol),
		rename_symbol: createRenameSymbolTool(cwd, options?.symbol),
		safe_delete_symbol: createSafeDeleteSymbolTool(cwd, options?.symbol),
	};
}
