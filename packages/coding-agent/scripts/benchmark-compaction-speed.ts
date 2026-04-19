import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { createHarness } from "../test/suite/harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "../test/fixtures/before-compaction.jsonl");
const WARMUP_SAMPLES = 2;
const MEASURED_SAMPLES = 11;
const TOTAL_SAMPLES = WARMUP_SAMPLES + MEASURED_SAMPLES;

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) {
		return sorted[middle] ?? 0;
	}
	return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

async function buildHarness() {
	const harness = await createHarness();
	harness.sessionManager.setSessionFile(FIXTURE_PATH);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return harness;
}

async function measureCompaction() {
	const durations: number[] = [];
	const tokensBefore: number[] = [];

	for (let i = 0; i < TOTAL_SAMPLES; i++) {
		const harness = await buildHarness();
		try {
			harness.setResponses([
				fauxAssistantMessage("## Goal\nBenchmark compaction speed\n\n## Progress\n### Done\n- [x] Loaded realistic fixture"),
				fauxAssistantMessage("## Original Request\nPreserve the turn boundary context for the kept suffix."),
				fauxAssistantMessage("extra summary"),
			]);

			const start = performance.now();
			const result = await harness.session.compact();
			const end = performance.now();

			if (i >= WARMUP_SAMPLES) {
				durations.push(end - start);
				tokensBefore.push(result.tokensBefore);
			}
		} finally {
			harness.cleanup();
		}
	}

	return {
		compactionMs: median(durations),
		tokensBefore: median(tokensBefore),
	};
}

const result = await measureCompaction();

console.log(`METRIC compaction_ms=${result.compactionMs.toFixed(3)}`);
console.log(`METRIC tokens_before=${result.tokensBefore.toFixed(0)}`);
