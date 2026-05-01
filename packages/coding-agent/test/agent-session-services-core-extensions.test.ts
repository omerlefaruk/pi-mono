import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("createAgentSessionServices core extension wiring", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pi-core-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		dirs.push(dir);
		return dir;
	}

	it("loads halo before pi-mem by default", async () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage: AuthStorage.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			modelRegistry: ModelRegistry.create(AuthStorage.inMemory(), join(agentDir, "models.json")),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});

		const extensions = services.resourceLoader.getExtensions().extensions;
		const haloIndex = extensions.findIndex((extension) => extension.commands.has("halo-status"));
		const piMemIndex = extensions.findIndex((extension) => extension.commands.has("mem"));
		expect(haloIndex).toBeGreaterThanOrEqual(0);
		expect(piMemIndex).toBeGreaterThanOrEqual(0);
		expect(haloIndex).toBeLessThan(piMemIndex);
	});

	it("does not prepend built-ins when caller already supplies halo and pi-mem factories", async () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage: AuthStorage.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			modelRegistry: ModelRegistry.create(AuthStorage.inMemory(), join(agentDir, "models.json")),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					function haloCustom(pi) {
						pi.registerCommand("halo-status", { handler: async () => {} });
					},
					function piMemCustom(pi) {
						pi.registerCommand("mem", { handler: async () => {} });
					},
				],
			},
		});

		const extensions = services.resourceLoader.getExtensions().extensions;
		expect(extensions).toHaveLength(2);
		expect(extensions.filter((extension) => extension.commands.has("halo-status"))).toHaveLength(1);
		expect(extensions.filter((extension) => extension.commands.has("mem"))).toHaveLength(1);
	});
});
