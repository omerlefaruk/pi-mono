import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Container, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.js";
import { theme } from "../../modes/interactive/theme/theme.js";
import { waitForChildProcess } from "../../utils/child-process.js";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

/**
 * Generate a unique temp file path for bash output.
 */
function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pi-bash-${id}.log`);
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) => {
			return new Promise((resolve, reject) => {
				const { shell, args } = getShellConfig(options?.shellPath);
				if (!existsSync(cwd)) {
					reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
					return;
				}
				const child = spawn(shell, [...args, command], {
					cwd,
					detached: process.platform !== "win32",
					env: env ?? getShellEnv(),
					stdio: ["ignore", "pipe", "pipe"],
				});
				if (child.pid) trackDetachedChildPid(child.pid);
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				// Set timeout if provided.
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeout * 1000);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				const onAbort = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				waitForChildProcess(child)
					.then((code) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						if (signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						if (timedOut) {
							reject(new Error(`timeout:${timeout}`));
							return;
						}
						resolve({ exitCode: code });
					})
					.catch((err) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						reject(err);
					});
			});
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

function getBarePathCommandCandidate(command: string): string | undefined {
	const trimmed = command.trim();
	const quoted = trimmed.match(/^["']([^"']+)["']$/)?.[1];
	const candidate = quoted ?? trimmed;
	if (!quoted && /\s/.test(candidate)) return undefined;
	return /^(?:[A-Za-z]:[\\/]|\/|~\/|\.\.?[\\/])/.test(candidate) ? candidate : undefined;
}

function isExplicitRelativeExecutable(candidate: string, cwd: string): boolean {
	if (!/^\.\.?[\\/]/.test(candidate)) return false;
	try {
		const stats = statSync(resolve(cwd, candidate));
		if (!stats.isFile()) return false;
		if (process.platform === "win32") return /\.(?:sh|bash|cmd|bat|ps1|exe)$/i.test(candidate);
		return (stats.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function msysSlashCommandName(command: string): string | undefined {
	const trimmed = command.trim();
	return trimmed.match(
		/^["']?(?:[A-Za-z]:\/Program Files\/Git|\/[a-z]\/Program Files\/Git)\/([A-Za-z0-9_-]+)(?:["']?(?:\s|$))/i,
	)?.[1];
}

const POWERSHELL_COMMAND_RE =
	/(?:^|[\s|;&(])(?:Get-ChildItem|Set-Location|Select-Object|Where-Object|ForEach-Object|Format-Table|New-Item|Remove-Item|Copy-Item|Move-Item|Test-Path|Get-Content|Set-Content|Write-Host|Start-Process)\b/i;
const POWERSHELL_VARIABLE_RE = /(?:^|\s)\$[A-Za-z_][\w:]*\s*=|\$env:[A-Za-z_][\w]*/i;
const VITEST_RE = /(?:^|[\s;&|])(?:npx\s+)?(?:vitest|vite-node\s+.*vitest|\.\/node_modules\/\.bin\/vitest)\b/i;

function classifyBashCommand(command: string, cwd: string): string | undefined {
	const convertedSlashCommand = msysSlashCommandName(command);
	if (convertedSlashCommand) {
		return `This looks like a slash command converted to a Git Bash path (${convertedSlashCommand}). Invoke slash commands from the pi input line, not through bash.`;
	}
	if (/^\s*(?:pwsh|powershell)(?:\.exe)?\s+-Command\b/i.test(command)) return undefined;
	if (POWERSHELL_COMMAND_RE.test(command) || POWERSHELL_VARIABLE_RE.test(command)) {
		return "This command looks like PowerShell syntax, but the bash tool runs a POSIX shell. Use POSIX shell syntax here (for example, ls/find/grep/sed), or explicitly run pwsh -Command if PowerShell is intended.";
	}
	const barePathCandidate = getBarePathCommandCandidate(command);
	if (barePathCandidate && !isExplicitRelativeExecutable(barePathCandidate, cwd)) {
		if (/^\.\.?[\\/]/.test(barePathCandidate)) {
			return `Refusing to execute a bare relative path (${barePathCandidate}). If this is an executable script, run it explicitly with an interpreter such as bash ${barePathCandidate}. For autoresearch, prefer run_experiment.`;
		}
		return "Refusing to execute a bare path. Inspect the path with read/ls first, or run an explicit command with arguments if execution is intended.";
	}
	const testCommandIssue = classifyTestCommand(command, cwd);
	if (testCommandIssue) return testCommandIssue;
	if (process.platform === "win32" && /(?:^|[\s;&|])ln\s+-s\b/.test(command)) {
		return "This command creates a symlink on Windows. Check Developer Mode/admin symlink privileges first, or use a copy/junction fallback for portable tests.";
	}
	return undefined;
}

function classifyTestCommand(command: string, cwd: string): string | undefined {
	if (VITEST_RE.test(command)) {
		if (/(?:^|\s)--runInBand(?:\s|$)/.test(command)) {
			return "Vitest does not support Jest's --runInBand flag. Use a Vitest-supported profile such as --pool=forks --poolOptions.forks.singleFork=true, or omit the flag.";
		}
		if ((command.match(/(?:^|\s)--run(?=\s|$)/g) ?? []).length > 1) {
			return "Vitest --run was specified more than once. Remove the duplicate flag before running the test command.";
		}
	}

	const npmScript = command.match(/^\s*npm\s+run\s+([^\s;&|]+)([\s\S]*)$/);
	if (!npmScript) return undefined;
	const packageJson = readNearestPackageJson(cwd);
	if (!packageJson) {
		return "npm run was requested outside a package directory. Change to the package/workspace root that contains package.json, or use npm --prefix <dir> run <script>.";
	}
	const scriptName = npmScript[1];
	const script = packageJson.scripts?.[scriptName];
	if (!script) {
		return `package.json does not define script "${scriptName}" in ${packageJson.path}. Run npm run to list available scripts or change to the correct workspace.`;
	}
	const forwardedArgs = npmScript[2] ?? "";
	if (
		/\bvitest\b/.test(script) &&
		/(?:^|\s)--run(?=\s|$)/.test(script) &&
		/(?:^|\s)--\s+[\s\S]*--run(?=\s|$)/.test(forwardedArgs)
	) {
		return `The npm script "${scriptName}" already includes vitest --run; remove the forwarded duplicate --run flag.`;
	}
	return undefined;
}

function readNearestPackageJson(cwd: string): { path: string; scripts?: Record<string, string> } | undefined {
	let dir = cwd;
	for (;;) {
		const path = join(dir, "package.json");
		if (existsSync(path)) {
			try {
				const parsed = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, string> };
				return { path, scripts: parsed.scripts };
			} catch {
				return { path };
			}
		}
		const parent = resolve(dir, "..");
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function normalizeCommandForLoopGuard(command: string): string {
	return command.trim().replace(/\s+/g, " ").slice(0, 500);
}

function normalizeFailureForLoopGuard(output: string): string {
	return output
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|seconds?)\b/gi, "<duration>")
		.replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
		.replace(/\b\d{4,}\b/g, "<number>")
		.replace(/[A-Za-z]:[\\/][^\s)]+/g, "<path>")
		.replace(/\/[^\s)]+/g, "<path>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(-1000);
}

interface FailedCommandSignature {
	count: number;
	lastFailure: string;
}

function formatRepeatedFailureMessage(command: string, failure: FailedCommandSignature): string {
	return [
		"Repeated bash failure detected. The same command has already failed twice with a similar error, so pi will not run it again without a changed command or new diagnostic step.",
		`Command: ${command}`,
		`Failure signature: ${failure.lastFailure || "(no output)"}`,
		"Next action: inspect the failing script/config/module path, run a narrower diagnostic command, or change the command materially before retrying.",
	].join("\n");
}

interface GitInvocation {
	subcommand?: string;
	cwd: string;
}

function parseGitInvocation(command: string, cwd: string): GitInvocation | undefined {
	const match = command.match(/^\s*git\b\s*([^;&|]*)/);
	if (!match) return undefined;
	const tokens = [...(match[1] ?? "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
		(token) => token[1] ?? token[2] ?? token[3] ?? "",
	);
	let gitCwd = cwd;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "-C") {
			const dir = tokens[++i];
			if (dir) gitCwd = resolve(gitCwd, dir);
			continue;
		}
		if (token.startsWith("-C") && token.length > 2) {
			gitCwd = resolve(gitCwd, token.slice(2));
			continue;
		}
		return { subcommand: token, cwd: gitCwd };
	}
	return { cwd: gitCwd };
}

function isGitMutationCommand(command: string, cwd: string): boolean {
	return ["commit", "merge", "cherry-pick", "rebase"].includes(parseGitInvocation(command, cwd)?.subcommand ?? "");
}

function gitMutationVerb(command: string, cwd: string): string | undefined {
	const subcommand = parseGitInvocation(command, cwd)?.subcommand;
	return ["commit", "merge", "cherry-pick", "rebase"].includes(subcommand ?? "") ? subcommand : undefined;
}

function isGitMutationContinuation(command: string): boolean {
	return /\s--(?:continue|abort|skip)\b/.test(command);
}

async function runPreflightProbe(
	ops: BashOperations,
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; output: string }> {
	const chunks: Buffer[] = [];
	const result = await ops.exec(command, cwd, {
		onData: (data) => chunks.push(data),
		timeout: 5,
		env,
	});
	return { exitCode: result.exitCode, output: Buffer.concat(chunks).toString("utf-8").trim() };
}

function requiresGitWorkTree(
	invocation: GitInvocation | undefined,
): invocation is GitInvocation & { subcommand: string } {
	const subcommand = invocation?.subcommand;
	if (!subcommand) return false;
	return !new Set(["--version", "version", "clone", "init", "config", "help", "lfs"]).has(subcommand);
}

async function runGitWorkTreePreflight(
	command: string,
	spawnContext: BashSpawnContext,
	ops: BashOperations,
): Promise<void> {
	const invocation = parseGitInvocation(command, spawnContext.cwd);
	if (!requiresGitWorkTree(invocation)) return;
	const insideWorkTree = await runPreflightProbe(
		ops,
		"git rev-parse --is-inside-work-tree >/dev/null 2>&1",
		invocation.cwd,
		spawnContext.env,
	);
	if (insideWorkTree.exitCode !== 0) {
		throw new Error(
			`Git preflight failed: target directory is not inside a git worktree (${invocation.cwd}). Change to the repository root/subdirectory, or run git clone/init if you intended to create a repository.`,
		);
	}
}

async function runGitMutationPreflight(
	command: string,
	spawnContext: BashSpawnContext,
	ops: BashOperations,
): Promise<void> {
	if (!isGitMutationCommand(command, spawnContext.cwd)) return;
	const verb = gitMutationVerb(command, spawnContext.cwd);
	const invocation = parseGitInvocation(command, spawnContext.cwd);
	const gitCwd = invocation?.cwd ?? spawnContext.cwd;
	const insideWorkTree = await runPreflightProbe(
		ops,
		"git rev-parse --is-inside-work-tree >/dev/null 2>&1",
		gitCwd,
		spawnContext.env,
	);
	if (insideWorkTree.exitCode !== 0) return;

	const operationState = await runPreflightProbe(
		ops,
		'state=$(for p in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD REBASE_HEAD; do f=$(git rev-parse --git-path "$p" 2>/dev/null); if [ -e "$f" ]; then echo "$p"; fi; done; for d in rebase-merge rebase-apply; do f=$(git rev-parse --git-path "$d" 2>/dev/null); if [ -d "$f" ]; then echo "$d"; fi; done); if [ -z "$state" ]; then exit 0; else echo "$state"; exit 1; fi',
		gitCwd,
		spawnContext.env,
	);
	if (operationState.exitCode !== 0 && !isGitMutationContinuation(command)) {
		throw new Error(
			`Git mutation preflight failed: another git operation appears to be in progress (${operationState.output}). Resolve or abort it before starting ${verb}.`,
		);
	}

	if (verb === "commit") {
		const identity = await runPreflightProbe(
			ops,
			'test -n "$(git config --get user.name)" && test -n "$(git config --get user.email)"',
			gitCwd,
			spawnContext.env,
		);
		if (identity.exitCode !== 0) {
			throw new Error(
				"Git mutation preflight failed: committer identity is not configured. Set git user.name and user.email before running git commit.",
			);
		}
	}

	if ((verb === "merge" || verb === "cherry-pick" || verb === "rebase") && !isGitMutationContinuation(command)) {
		if (verb === "rebase" && /\s--autostash\b/.test(command)) return;
		const status = await runPreflightProbe(ops, "git status --porcelain", gitCwd, spawnContext.env);
		if (status.exitCode === 0 && status.output) {
			throw new Error(
				`Git mutation preflight failed: worktree has uncommitted changes. Commit or stash the specific files before running git ${verb}.`,
			);
		}
	}
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 5;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	const output = getTextOutput(result as any, showImages).trim();

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")})`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	const failedCommands = new Map<string, FailedCommandSignature>();
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		promptGuidelines: [
			"Use bash for commands and scripts, but prefer read/grep/find/ls for file exploration.",
			"Do not execute a bare path with bash; inspect it with read/ls or ask for confirmation first.",
			"Use POSIX shell syntax in bash; wrap PowerShell syntax explicitly with pwsh -Command when needed.",
			"Before git commit/merge/cherry-pick/rebase, expect pi to run cheap preflight checks for identity, operation state, and dirty worktrees.",
			"On Windows, avoid Jest-only flags such as --runInBand with Vitest and account for symlink privilege requirements.",
		],
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const commandIssue = classifyBashCommand(command, cwd);
			if (commandIssue) throw new Error(commandIssue);

			const loopGuardKey = normalizeCommandForLoopGuard(command);
			const previousFailure = failedCommands.get(loopGuardKey);
			if (previousFailure && previousFailure.count >= 2) {
				throw new Error(formatRepeatedFailureMessage(loopGuardKey, previousFailure));
			}

			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			if (/^\s*git\b/.test(command)) {
				await runGitWorkTreePreflight(command, spawnContext, ops);
				await runGitMutationPreflight(command, spawnContext, ops);
			}
			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}
			return new Promise((resolve, reject) => {
				let tempFilePath: string | undefined;
				let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
				let totalBytes = 0;
				const chunks: Buffer[] = [];
				let chunksBytes = 0;
				const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

				const recordFailure = (output: string) => {
					const normalizedFailure = normalizeFailureForLoopGuard(output);
					const current = failedCommands.get(loopGuardKey);
					if (current && current.lastFailure === normalizedFailure) {
						current.count += 1;
					} else {
						failedCommands.set(loopGuardKey, { count: 1, lastFailure: normalizedFailure });
					}
				};

				const clearFailure = () => {
					failedCommands.delete(loopGuardKey);
				};

				const ensureTempFile = () => {
					if (tempFilePath) return;
					tempFilePath = getTempFilePath();
					tempFileStream = createWriteStream(tempFilePath);
					for (const chunk of chunks) tempFileStream.write(chunk);
				};

				const handleData = (data: Buffer) => {
					totalBytes += data.length;
					// Start writing to a temp file once output exceeds the in-memory threshold.
					if (totalBytes > DEFAULT_MAX_BYTES) {
						ensureTempFile();
					}
					// Write to temp file if we have one.
					if (tempFileStream) tempFileStream.write(data);
					// Keep a rolling buffer of recent output for tail truncation.
					chunks.push(data);
					chunksBytes += data.length;
					// Trim old chunks if the rolling buffer grows too large.
					while (chunksBytes > maxChunksBytes && chunks.length > 1) {
						const removed = chunks.shift()!;
						chunksBytes -= removed.length;
					}
					// Stream partial output using the rolling tail buffer.
					if (onUpdate) {
						const fullBuffer = Buffer.concat(chunks);
						const fullText = fullBuffer.toString("utf-8");
						const truncation = truncateTail(fullText);
						if (truncation.truncated) {
							ensureTempFile();
						}
						onUpdate({
							content: [{ type: "text", text: truncation.content || "" }],
							details: {
								truncation: truncation.truncated ? truncation : undefined,
								fullOutputPath: tempFilePath,
							},
						});
					}
				};

				ops.exec(spawnContext.command, spawnContext.cwd, {
					onData: handleData,
					signal,
					timeout,
					env: spawnContext.env,
				})
					.then(({ exitCode }) => {
						// Combine the rolling buffer chunks.
						const fullBuffer = Buffer.concat(chunks);
						const fullOutput = fullBuffer.toString("utf-8");
						// Apply tail truncation for the final display payload.
						const truncation = truncateTail(fullOutput);
						if (truncation.truncated) {
							ensureTempFile();
						}
						// Close temp file stream before building the final result.
						if (tempFileStream) tempFileStream.end();
						let outputText = truncation.content || "(no output)";
						let details: BashToolDetails | undefined;
						if (truncation.truncated) {
							// Build truncation details and an actionable notice.
							details = { truncation, fullOutputPath: tempFilePath };
							const startLine = truncation.totalLines - truncation.outputLines + 1;
							const endLine = truncation.totalLines;
							if (truncation.lastLinePartial) {
								// Edge case: the last line alone is larger than the byte limit.
								const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
								outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
							} else if (truncation.truncatedBy === "lines") {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
							} else {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
							}
						}
						if (exitCode !== 0 && exitCode !== null) {
							outputText += `\n\nCommand exited with code ${exitCode}`;
							recordFailure(outputText);
							reject(new Error(outputText));
						} else {
							clearFailure();
							resolve({ content: [{ type: "text", text: outputText }], details });
						}
					})
					.catch((err: Error) => {
						// Close temp file stream and include buffered output in the error message.
						if (tempFileStream) tempFileStream.end();
						const fullBuffer = Buffer.concat(chunks);
						let output = fullBuffer.toString("utf-8");
						if (err.message === "aborted") {
							if (output) output += "\n\n";
							output += "Command aborted";
							recordFailure(output);
							reject(new Error(output));
						} else if (err.message.startsWith("timeout:")) {
							const timeoutSecs = err.message.split(":")[1];
							if (output) output += "\n\n";
							output += `Command timed out after ${timeoutSecs} seconds`;
							recordFailure(output);
							reject(new Error(output));
						} else {
							recordFailure(err.message);
							reject(err);
						}
					});
			});
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
