import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import type { ExtensionFactory } from "../src/core/sdk.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("AgentSession MSYS slash-command normalization", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-msys-command-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(extensionFactories: ExtensionFactory[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			authStorage,
			resourceLoader,
		});
		await session.bindExtensions({});
		return session;
	}

	it("executes registered slash commands rewritten by Git Bash into Program Files paths", async () => {
		let commandArgs: string | undefined;
		const session = await createSession([
			(pi) => {
				pi.registerCommand("halo-status", {
					handler: async (args) => {
						commandArgs = args;
					},
				});
			},
		]);
		session.agent.streamFn = async () => {
			throw new Error("prompt should have been handled as an extension command");
		};

		await session.prompt("C:/Program Files/Git/halo-status extra");

		expect(commandArgs).toBe("extra");
		session.dispose();
	});
});
