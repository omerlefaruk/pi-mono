import { visibleWidth } from "@mariozechner/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	contextTokens?: number | null;
	maxContextTokens?: number;
	reserveTokens?: number;
	contextWindow?: number;
	usingOAuth?: boolean;
}): AgentSession {
	const usage = options.usage;
	const entries =
		usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
				];

	const contextWindow = options.contextWindow ?? 200_000;
	const contextTokens = options.contextTokens ?? 24_600;
	const percent = contextTokens === null ? null : (contextTokens / contextWindow) * 100;

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		settingsManager: {
			getCompactionSettings: () => ({
				enabled: true,
				reserveTokens: options.reserveTokens ?? 16_384,
				keepRecentTokens: 20_000,
				maxContextTokens: options.maxContextTokens,
			}),
		},
		getContextUsage: () => ({ contextWindow, tokens: contextTokens, percent }),
		modelRegistry: {
			isUsingOAuth: () => options.usingOAuth ?? false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
			contextTokens: 168_900,
			maxContextTokens: 170_000,
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows current context against the compaction trigger", () => {
		const session = createSession({
			sessionName: "",
			contextTokens: 168_900,
			maxContextTokens: 170_000,
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const rendered = footer
			.render(120)
			.join("\n")
			.replace(/\u001b\[[0-9;]*m/g, "");

		expect(rendered).toContain("ctx 169k/170k (auto)");
	});

	it("hides zero-cost subscription badges", () => {
		const session = createSession({
			sessionName: "",
			usingOAuth: true,
			usage: {
				input: 100,
				output: 200,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const rendered = footer
			.render(120)
			.join("\n")
			.replace(/\u001b\[[0-9;]*m/g, "");

		expect(rendered).not.toContain("$0.000 (sub)");
	});
});
