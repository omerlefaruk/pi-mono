import { performance } from "node:perf_hooks";
import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { createHarness } from "../test/suite/harness.js";

const CONTINUE_PROMPT =
	"Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";
const SAMPLES = 9;

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) {
		return sorted[middle] ?? 0;
	}
	return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

async function buildHarness() {
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "bench auto compacted",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
		],
	});

	harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	await harness.session.prompt("first");
	await harness.session.prompt("second");
	return harness;
}

async function measureThresholdResume(): Promise<number> {
	const samples: number[] = [];
	for (let i = 0; i < SAMPLES; i++) {
		const harness = await buildHarness();
		try {
			const internals = harness.session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			};
			const agentInternals = harness.session.agent as unknown as {
				runPromptMessages: (messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>) => Promise<void>;
			};
			let recordedMessages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> = [];
			const originalRunPromptMessages = agentInternals.runPromptMessages.bind(harness.session.agent);
			const observed = new Promise<number>((resolve) => {
				agentInternals.runPromptMessages = (async (messages) => {
					recordedMessages = messages;
					resolve(performance.now());
					return await originalRunPromptMessages(messages);
				}) as typeof agentInternals.runPromptMessages;
			});
			const start = performance.now();
			await internals._runAutoCompaction("threshold", false);
			const end = await observed;
			samples.push(end - start);
			if (recordedMessages[0]?.content[0]?.text !== CONTINUE_PROMPT) {
				throw new Error("synthetic threshold continue follow-up was not recorded");
			}
		} finally {
			harness.cleanup();
		}
	}
	return median(samples);
}

async function measureQueuedResume(): Promise<number> {
	const samples: number[] = [];
	for (let i = 0; i < SAMPLES; i++) {
		const harness = await buildHarness();
		try {
			harness.session.agent.followUp({
				role: "custom",
				customType: "bench",
				content: [{ type: "text", text: "queued custom" }],
				display: false,
				timestamp: Date.now(),
			});
			const internals = harness.session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			};
			const agentInternals = harness.session.agent as unknown as {
				runPromptMessages: (messages: Array<{ role: string; customType?: string }>) => Promise<void>;
			};
			let recordedMessages: Array<{ role: string; customType?: string }> = [];
			const originalRunPromptMessages = agentInternals.runPromptMessages.bind(harness.session.agent);
			const observed = new Promise<number>((resolve) => {
				agentInternals.runPromptMessages = (async (messages) => {
					recordedMessages = messages;
					resolve(performance.now());
					return await originalRunPromptMessages(messages);
				}) as typeof agentInternals.runPromptMessages;
			});
			const start = performance.now();
			await internals._runAutoCompaction("threshold", false);
			const end = await observed;
			samples.push(end - start);
			if (recordedMessages[0]?.customType !== "bench") {
				throw new Error("queued follow-up did not resume first");
			}
		} finally {
			harness.cleanup();
		}
	}
	return median(samples);
}

const thresholdResumeMs = await measureThresholdResume();
const queuedResumeMs = await measureQueuedResume();

console.log(`METRIC threshold_resume_ms=${thresholdResumeMs.toFixed(3)}`);
console.log(`METRIC queued_resume_ms=${queuedResumeMs.toFixed(3)}`);
