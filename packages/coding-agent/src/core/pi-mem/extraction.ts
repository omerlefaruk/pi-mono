import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolResultEvent } from "../extensions/index.js";
import type { PiMemRecordType } from "./types.js";

const CATEGORY_PATTERNS: Array<{
	pattern: RegExp;
	type: PiMemRecordType;
	tags: string[];
	importance: number;
	confidence: number;
}> = [
	{
		pattern: /\bprefer(?:s|ence)?\b|\balways\b|\bdefault to\b/i,
		type: "preference",
		tags: ["preference"],
		importance: 0.8,
		confidence: 0.8,
	},
	{
		pattern: /\bdecision\b|\bdecided\b|\bchose\b|\barchitecture\b/i,
		type: "decision",
		tags: ["decision"],
		importance: 0.8,
		confidence: 0.75,
	},
	{
		pattern: /\bfact\b|\bis\b|\buses\b|\brequires\b/i,
		type: "fact",
		tags: ["fact"],
		importance: 0.6,
		confidence: 0.65,
	},
	{
		pattern: /\bfixed\b|\bfix\b|\bresolved\b|\broot cause\b/i,
		type: "fix",
		tags: ["fix"],
		importance: 0.85,
		confidence: 0.8,
	},
	{
		pattern: /\bfailed\b|\bdidn't work\b|\bdid not work\b|\brollback_reason\b/i,
		type: "failed_attempt",
		tags: ["failure"],
		importance: 0.7,
		confidence: 0.75,
	},
	{
		pattern: /\btodo\b|\bnext action\b|\bneed to\b|\bfollow up\b/i,
		type: "todo",
		tags: ["todo"],
		importance: 0.7,
		confidence: 0.7,
	},
];

const HIGH_SIGNAL_PATTERNS = [
	/\bremember\b/i,
	/\bprefer(s|ence)?\b/i,
	/\bfixed\b/i,
	/\bfailed\b/i,
	/\bdo not\b/i,
	/\barchitecture\b/i,
	/\bdecision\b/i,
	/\broot cause\b/i,
	/\bnext action\b/i,
	/\brollback_reason\b/i,
];

export interface MemoryCandidate {
	summary: string;
	content: string;
	type?: PiMemRecordType;
	tags?: string[];
	importance?: number;
	confidence?: number;
}

export function extractMemoryCandidatesFromMessage(
	message: AgentMessage,
	mode: "heuristic" | "model" = "heuristic",
): MemoryCandidate[] {
	if (mode === "model") return extractMemoryCandidatesModelFallback();
	if (message.role !== "assistant") return [];
	const text = message.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
	if (!text) return [];
	const lines = text
		.split("\n")
		.map((line) => line.trim().replace(/^[-*]\s+/, ""))
		.filter((line) => line.length >= 24 && HIGH_SIGNAL_PATTERNS.some((pattern) => pattern.test(line)))
		.slice(0, 3);
	return lines.map((line) => {
		const category = detectCategory(line);
		return {
			summary: truncate(line, 120),
			content: line,
			type: category.type,
			tags: category.tags,
			importance: category.importance,
			confidence: category.confidence,
		};
	});
}

export function extractMemoryCandidatesFromToolResult(
	event: ToolResultEvent,
	mode: "heuristic" | "model" = "heuristic",
): MemoryCandidate[] {
	if (mode === "model") return extractMemoryCandidatesModelFallback();
	const text = event.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
	if (!text) return [];
	const first = text
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	if (!first) return [];
	if (event.isError) {
		return [
			{
				summary: `${event.toolName} failed: ${truncate(first, 100)}`,
				content: truncate(text, 1000),
				type: "failed_attempt",
				tags: ["failure"],
				importance: 0.75,
				confidence: 0.8,
			},
		];
	}
	if (!looksUsefulToolResult(event.toolName, text)) return [];
	const category = detectCategory(text);
	return [
		{
			summary: `${event.toolName}: ${truncate(first, 100)}`,
			content: truncate(text, 1000),
			type: category.type,
			tags: category.tags,
			importance: category.importance,
			confidence: category.confidence,
		},
	];
}

function detectCategory(text: string): Required<Pick<MemoryCandidate, "type" | "tags" | "importance" | "confidence">> {
	for (const category of CATEGORY_PATTERNS) {
		if (category.pattern.test(text)) {
			return {
				type: category.type,
				tags: category.tags,
				importance: category.importance,
				confidence: category.confidence,
			};
		}
	}
	return { type: "observation", tags: ["observation"], importance: 0.55, confidence: 0.6 };
}

function looksUsefulToolResult(toolName: string, text: string): boolean {
	if (toolName === "edit" || toolName === "write") return true;
	return HIGH_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

function extractMemoryCandidatesModelFallback(): MemoryCandidate[] {
	return [];
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
