import type { PiMemRecord } from "./types.js";

export function formatInjectedMemories(memories: PiMemRecord[]): string {
	if (memories.length === 0) return "";
	const body = memories
		.map((m) => {
			const citations = m.citations?.length
				? `, citations: ${m.citations
						.map((c) => [c.traceId, c.spanId, c.toolName].filter(Boolean).join("/"))
						.join(",")}`
				: "";
			const feedback = `, pinned: ${Boolean(m.pinned)}, stale: ${Boolean(m.stale)}, wrong: ${Boolean(m.wrong)}, useful: ${m.usefulCount ?? 0}`;
			return `- [${m.id}] ${m.summary} (tags: ${m.tags.join(",") || "none"}, source: ${m.source}${feedback}${citations})`;
		})
		.join("\n");
	return `Relevant Pi Mem memories (may be stale; verify against files/HALO traces when important):\n${body}`;
}
