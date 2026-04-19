/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

function collectTextContent(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	if (content.length === 1) {
		const block = content[0];
		if (block?.type === "text" && typeof block.text === "string") {
			return block.text;
		}
	}
	let result = "";
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			result += block.text;
		}
	}
	return result;
}

function stringifyToolCallArguments(args: Record<string, unknown>): string {
	let result = "";
	let first = true;
	for (const key in args) {
		if (!Object.hasOwn(args, key)) continue;
		if (!first) result += ", ";
		result += `${key}=${JSON.stringify(args[key])}`;
		first = false;
	}
	return result;
}

function appendSection(output: string, section: string): string {
	return output ? `${output}\n\n${section}` : section;
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[]): string {
	let output = "";

	for (const msg of messages) {
		if (msg.role === "user") {
			const content = collectTextContent(msg.content as string | Array<{ type: string; text?: string }>);
			if (content) {
				output = appendSection(output, `[User]: ${content}`);
			}
			continue;
		}

		if (msg.role === "assistant") {
			let text = "";
			let thinking = "";
			let toolCalls = "";

			for (const block of msg.content) {
				if (block.type === "text") {
					text += text ? `\n${block.text}` : block.text;
				} else if (block.type === "thinking") {
					thinking += thinking ? `\n${block.thinking}` : block.thinking;
				} else if (block.type === "toolCall") {
					const toolCall = `${block.name}(${stringifyToolCallArguments(block.arguments as Record<string, unknown>)})`;
					toolCalls += toolCalls ? `; ${toolCall}` : toolCall;
				}
			}

			if (thinking) {
				output = appendSection(output, `[Assistant thinking]: ${thinking}`);
			}
			if (text) {
				output = appendSection(output, `[Assistant]: ${text}`);
			}
			if (toolCalls) {
				output = appendSection(output, `[Assistant tool calls]: ${toolCalls}`);
			}
			continue;
		}

		if (msg.role === "toolResult") {
			const content = collectTextContent(msg.content as Array<{ type: string; text?: string }>);
			if (content) {
				output = appendSection(output, `[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return output;
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
