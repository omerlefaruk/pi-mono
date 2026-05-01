import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PiMemRecord, PiMemRecordType, PiMemSearchInput } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface SqliteState {
	db: any;
	path: string;
}

export class PiMemStore {
	private readonly storageBackend: "jsonl" | "sqlite" | "auto";
	private sqliteState: Promise<SqliteState | null> | undefined;

	constructor(
		private readonly storePath: string,
		options?: {
			storageBackend?: "jsonl" | "sqlite" | "auto";
		},
	) {
		this.storageBackend = options?.storageBackend ?? "jsonl";
	}

	async list(): Promise<PiMemRecord[]> {
		const sqlite = await this.getSqliteState();
		if (sqlite) {
			try {
				return sqlite.db
					.prepare("SELECT record FROM memories ORDER BY updated_at ASC")
					.all()
					.map((row: { record: string }) => JSON.parse(row.record) as PiMemRecord);
			} catch {
				return [];
			}
		}
		try {
			const content = await readFile(this.storePath, "utf8");
			return content
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line) => JSON.parse(line) as PiMemRecord);
		} catch {
			return [];
		}
	}

	async append(record: Omit<PiMemRecord, "id" | "createdAt" | "updatedAt">): Promise<PiMemRecord> {
		const now = Date.now();
		const all = await this.list();
		const dedup = findBestDuplicate(record, all);
		if (dedup) {
			const merged = mergeRecords(dedup, record, now);
			const next = all.map((entry) => (entry.id === dedup.id ? merged : entry));
			await this.writeAll(next);
			return merged;
		}
		const next: PiMemRecord = { ...record, id: randomUUID(), createdAt: now, updatedAt: now };
		all.push(next);
		await this.writeAll(all);
		return next;
	}

	async forget(id: string): Promise<boolean> {
		const all = await this.list();
		const next = all.filter((m) => m.id !== id);
		if (next.length === all.length) return false;
		await this.writeAll(next);
		return true;
	}

	async get(id: string): Promise<PiMemRecord | undefined> {
		return (await this.list()).find((m) => m.id === id);
	}

	async setFeedback(
		id: string,
		feedback: {
			pinned?: boolean;
			stale?: boolean;
			wrong?: boolean;
			usefulDelta?: number;
			staleDelta?: number;
			wrongDelta?: number;
		},
	): Promise<PiMemRecord | undefined> {
		const all = await this.list();
		const index = all.findIndex((m) => m.id === id);
		if (index < 0) return undefined;
		const current = all[index]!;
		const next: PiMemRecord = {
			...current,
			updatedAt: Date.now(),
			pinned: feedback.pinned ?? current.pinned,
			stale: feedback.stale ?? current.stale,
			wrong: feedback.wrong ?? current.wrong,
			usefulCount: Math.max(0, (current.usefulCount ?? 0) + (feedback.usefulDelta ?? 0)),
			staleCount: Math.max(0, (current.staleCount ?? 0) + (feedback.staleDelta ?? 0)),
			wrongCount: Math.max(0, (current.wrongCount ?? 0) + (feedback.wrongDelta ?? 0)),
		};
		all[index] = next;
		await this.writeAll(all);
		return next;
	}

	async purge(input?: {
		namespace?: string;
		cwd?: string;
		projectId?: string;
		includePinned?: boolean;
		includeWrong?: boolean;
	}): Promise<number> {
		const all = await this.list();
		const keep = all.filter((m) => {
			if (input?.namespace && m.namespace !== input.namespace) return true;
			if (input?.cwd && m.cwd !== input.cwd) return true;
			if (input?.projectId && m.projectId && m.projectId !== input.projectId) return true;
			if (!input?.includePinned && m.pinned) return true;
			if (!input?.includeWrong && m.wrong) return true;
			return false;
		});
		const removed = all.length - keep.length;
		if (removed > 0) await this.writeAll(keep);
		return removed;
	}

	async importRecords(
		records: PiMemRecord[],
		options?: { namespace?: string; cwd?: string; projectId?: string },
	): Promise<{ imported: number; merged: number }> {
		let imported = 0;
		let merged = 0;
		for (const record of records) {
			const before = (await this.list()).length;
			await this.append(
				this.createRecordBase({
					type: record.type,
					summary: record.summary,
					content: record.content,
					tags: record.tags,
					namespace: options?.namespace ?? record.namespace,
					projectId: options?.projectId ?? record.projectId,
					cwd: options?.cwd ?? record.cwd,
					sessionId: record.sessionId,
					sessionFile: record.sessionFile,
					confidence: record.confidence,
					importance: record.importance,
					source: record.source,
					privacy: record.privacy,
					citations: record.citations,
					pinned: record.pinned,
					stale: record.stale,
					wrong: record.wrong,
					usefulCount: record.usefulCount,
					wrongCount: record.wrongCount,
					staleCount: record.staleCount,
				}),
			);
			const after = (await this.list()).length;
			if (after > before) imported++;
			else merged++;
		}
		return { imported, merged };
	}

	async stats(input?: { namespace?: string; namespaces?: string[]; cwd?: string; projectId?: string }): Promise<{
		total: number;
		pinned: number;
		stale: number;
		wrong: number;
		byType: Record<string, number>;
		byPrivacy: Record<string, number>;
	}> {
		const all = await this.list();
		const filtered = all.filter((m) => {
			if (input?.namespace && m.namespace !== input.namespace) return false;
			if (input?.namespaces?.length && !input.namespaces.includes(m.namespace ?? "")) return false;
			if (input?.cwd && m.cwd !== input.cwd) return false;
			if (input?.projectId && m.projectId && m.projectId !== input.projectId) return false;
			return true;
		});
		const byType: Record<string, number> = {};
		const byPrivacy: Record<string, number> = {};
		for (const m of filtered) {
			byType[m.type] = (byType[m.type] ?? 0) + 1;
			byPrivacy[m.privacy] = (byPrivacy[m.privacy] ?? 0) + 1;
		}
		return {
			total: filtered.length,
			pinned: filtered.filter((m) => m.pinned).length,
			stale: filtered.filter((m) => m.stale).length,
			wrong: filtered.filter((m) => m.wrong).length,
			byType,
			byPrivacy,
		};
	}

	async search(
		input: PiMemSearchInput | string | undefined,
		limit?: number,
		namespace?: string,
	): Promise<PiMemRecord[]> {
		const query = typeof input === "string" || input === undefined ? input : input.query;
		const options: PiMemSearchInput =
			typeof input === "string" || input === undefined ? { query, limit, namespace } : input;
		const tokens = tokenize(query);
		const all = await this.list();
		const filtered = all.filter((m) => {
			if (options.namespace && m.namespace !== options.namespace) return false;
			if (options.namespaces?.length && !options.namespaces.includes(m.namespace ?? "")) return false;
			if (options.cwd && m.cwd !== options.cwd) return false;
			if (options.projectId && m.projectId && m.projectId !== options.projectId) return false;
			if (!options.includeSensitive && m.privacy === "sensitive") return false;
			if (m.wrong) return false;
			if (options.tags?.length && !options.tags.every((tag) => m.tags.includes(tag))) return false;
			if (tokens.length === 0) return true;
			const text = memorySearchText(m);
			return tokens.some((token) => text.includes(token));
		});
		return filtered
			.map((record) => ({ record, score: score(record, tokens) }))
			.sort((a, b) => b.score - a.score)
			.map((entry) => entry.record)
			.slice(0, options.limit ?? limit ?? 20);
	}

	createRecordBase(input: {
		type: PiMemRecordType;
		summary: string;
		content: string;
		tags?: string[];
		namespace?: string;
		projectId?: string;
		cwd: string;
		sessionId: string;
		sessionFile: string;
		confidence?: number;
		importance?: number;
		source: string;
		privacy?: "public" | "private" | "sensitive";
		citations?: PiMemRecord["citations"];
		pinned?: boolean;
		stale?: boolean;
		wrong?: boolean;
		usefulCount?: number;
		wrongCount?: number;
		staleCount?: number;
	}): Omit<PiMemRecord, "id" | "createdAt" | "updatedAt"> {
		return {
			type: input.type,
			summary: input.summary,
			content: input.content,
			tags: input.tags ?? [],
			namespace: input.namespace,
			projectId: input.projectId,
			cwd: input.cwd,
			sessionId: input.sessionId,
			sessionFile: input.sessionFile,
			confidence: input.confidence ?? 0.6,
			importance: input.importance ?? 0.5,
			source: input.source,
			privacy: input.privacy ?? "private",
			citations: input.citations,
			pinned: input.pinned ?? false,
			stale: input.stale ?? false,
			wrong: input.wrong ?? false,
			usefulCount: input.usefulCount ?? 0,
			wrongCount: input.wrongCount ?? 0,
			staleCount: input.staleCount ?? 0,
		};
	}

	async timeline(input?: {
		limit?: number;
		namespace?: string;
		namespaces?: string[];
		cwd?: string;
		projectId?: string;
	}): Promise<PiMemRecord[]> {
		const rows = await this.search({
			limit: input?.limit ?? 50,
			namespace: input?.namespace,
			namespaces: input?.namespaces,
			cwd: input?.cwd,
			projectId: input?.projectId,
			includeSensitive: true,
		});
		return rows.sort((a, b) => b.createdAt - a.createdAt);
	}

	async close(): Promise<void> {
		const sqlite = this.sqliteState ? await this.sqliteState : null;
		if (sqlite) sqlite.db.close();
		this.sqliteState = undefined;
	}

	async maintenance(
		action: "compact" = "compact",
	): Promise<{ backend: string; action: "compact"; status: string; before: number; after: number }> {
		const all = await this.list();
		const before = all.length;
		if (action !== "compact")
			return { backend: await this.backendLabel(), action: "compact", status: "noop", before, after: before };
		await this.writeAll(all);
		return { backend: await this.backendLabel(), action: "compact", status: "ok", before, after: before };
	}

	private async writeAll(records: PiMemRecord[]): Promise<void> {
		const sqlite = await this.getSqliteState();
		if (sqlite) {
			sqlite.db.exec("BEGIN");
			try {
				sqlite.db.exec("DELETE FROM memories");
				const insert = sqlite.db.prepare("INSERT INTO memories (id, record, updated_at) VALUES (?, ?, ?)");
				for (const record of records) {
					insert.run(record.id, JSON.stringify(record), record.updatedAt);
				}
				sqlite.db.exec("COMMIT");
				return;
			} catch (error) {
				sqlite.db.exec("ROLLBACK");
				throw error;
			}
		}
		await mkdir(dirname(this.storePath), { recursive: true });
		const content = `${records.map((r) => JSON.stringify(r)).join("\n")}${records.length > 0 ? "\n" : ""}`;
		await writeFile(this.storePath, content, "utf8");
	}

	private async backendLabel(): Promise<string> {
		const sqlite = await this.getSqliteState();
		if (sqlite) return this.storageBackend === "auto" ? "sqlite(auto)" : "sqlite";
		return this.storageBackend === "auto" ? "jsonl(auto)" : "jsonl";
	}

	private async getSqliteState(): Promise<SqliteState | null> {
		if (this.storageBackend === "jsonl") return null;
		if (!this.sqliteState) this.sqliteState = this.openSqliteState();
		return this.sqliteState;
	}

	private async openSqliteState(): Promise<SqliteState | null> {
		try {
			const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
			const sqlite = await importer("node:sqlite");
			const sqlitePath = this.sqlitePath();
			await mkdir(dirname(sqlitePath), { recursive: true });
			const db = new sqlite.DatabaseSync(sqlitePath);
			db.exec(
				"CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, record TEXT NOT NULL, updated_at INTEGER NOT NULL)",
			);
			return { db, path: sqlitePath };
		} catch {
			return null;
		}
	}

	private sqlitePath(): string {
		return this.storePath.endsWith(".jsonl")
			? `${this.storePath.slice(0, -".jsonl".length)}.sqlite`
			: `${this.storePath}.sqlite`;
	}
}

function score(record: PiMemRecord, tokens: string[]): number {
	const text = memorySearchText(record);
	const tokenHits = tokens.filter((token) => text.includes(token)).length;
	const overlapRatio = tokens.length === 0 ? 0 : tokenHits / tokens.length;
	const tagHits = tokens.filter((token) => record.tags.some((tag) => tag.toLowerCase().includes(token))).length;
	const recency = recencyWeight(record.updatedAt);
	const ageDecay = decayWeight(record.updatedAt, record.pinned ?? false, record.stale ?? false);
	const feedbackBoost =
		(record.usefulCount ?? 0) * 0.08 - (record.wrongCount ?? 0) * 0.3 - (record.staleCount ?? 0) * 0.15;
	const stateBoost = (record.pinned ? 1.2 : 0) + (record.stale ? -0.8 : 0) + (record.wrong ? -2 : 0);
	return (
		overlapRatio * 3 +
		tokenHits * 0.2 +
		tagHits * 0.35 +
		recency * 0.8 +
		record.importance * 1.2 +
		record.confidence * 0.9 +
		feedbackBoost +
		stateBoost +
		ageDecay
	);
}

function recencyWeight(updatedAt: number): number {
	const days = Math.max(0, (Date.now() - updatedAt) / DAY_MS);
	return 1 / (1 + days / 7);
}

function decayWeight(updatedAt: number, pinned: boolean, stale: boolean): number {
	if (pinned) return 0.6;
	const days = Math.max(0, (Date.now() - updatedAt) / DAY_MS);
	const halfLifeDays = stale ? 7 : 30;
	return 0.5 ** (days / halfLifeDays) - 1;
}

function findBestDuplicate(
	candidate: Omit<PiMemRecord, "id" | "createdAt" | "updatedAt">,
	existing: PiMemRecord[],
): PiMemRecord | undefined {
	let best: { record: PiMemRecord; score: number } | undefined;
	for (const current of existing) {
		if (candidate.cwd !== current.cwd) continue;
		if ((candidate.namespace ?? "") !== (current.namespace ?? "")) continue;
		const similarity = memorySimilarity(candidate, current);
		if (similarity < 0.65) continue;
		if (!best || similarity > best.score) best = { record: current, score: similarity };
	}
	return best?.record;
}

function memorySimilarity(
	a: Pick<PiMemRecord, "summary" | "content" | "type" | "tags">,
	b: Pick<PiMemRecord, "summary" | "content" | "type" | "tags">,
): number {
	const exact =
		normalizeText(a.summary) === normalizeText(b.summary) || normalizeText(a.content) === normalizeText(b.content);
	if (exact) return 1;
	const aTokens = tokenize(`${a.summary} ${a.content}`);
	const bTokens = tokenize(`${b.summary} ${b.content}`);
	const overlap = jaccard(aTokens, bTokens);
	const typeBonus = a.type === b.type ? 0.08 : 0;
	const tagBonus =
		jaccard(
			a.tags.map((t) => t.toLowerCase()),
			b.tags.map((t) => t.toLowerCase()),
		) * 0.08;
	return overlap + typeBonus + tagBonus;
}

function mergeRecords(
	existing: PiMemRecord,
	incoming: Omit<PiMemRecord, "id" | "createdAt" | "updatedAt">,
	now: number,
): PiMemRecord {
	return {
		...existing,
		type: existing.type === incoming.type ? existing.type : existing.type,
		summary: longerText(existing.summary, incoming.summary),
		content: longerText(existing.content, incoming.content),
		tags: [...new Set([...existing.tags, ...incoming.tags])],
		sessionId: incoming.sessionId,
		sessionFile: incoming.sessionFile,
		updatedAt: now,
		confidence: Math.min(1, Math.max(existing.confidence, incoming.confidence) + 0.03),
		importance: Math.min(1, Math.max(existing.importance, incoming.importance)),
		source: existing.source === incoming.source ? existing.source : `${existing.source}|${incoming.source}`,
		citations: mergeCitations(existing.citations, incoming.citations),
		privacy:
			existing.privacy === "sensitive" || incoming.privacy === "sensitive"
				? "sensitive"
				: existing.privacy === "private" || incoming.privacy === "private"
					? "private"
					: "public",
		pinned: (existing.pinned ?? false) || (incoming.pinned ?? false),
		stale: (existing.stale ?? false) && (incoming.stale ?? false),
		wrong: (existing.wrong ?? false) || (incoming.wrong ?? false),
		usefulCount: (existing.usefulCount ?? 0) + (incoming.usefulCount ?? 0),
		wrongCount: (existing.wrongCount ?? 0) + (incoming.wrongCount ?? 0),
		staleCount: (existing.staleCount ?? 0) + (incoming.staleCount ?? 0),
	};
}

function mergeCitations(a?: PiMemRecord["citations"], b?: PiMemRecord["citations"]): PiMemRecord["citations"] {
	const all = [...(a ?? []), ...(b ?? [])];
	if (all.length === 0) return undefined;
	const seen = new Set<string>();
	return all.filter((entry) => {
		const key = `${entry.traceId ?? ""}:${entry.spanId ?? ""}:${entry.toolName ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function longerText(a: string, b: string): string {
	return b.length > a.length ? b : a;
}

function jaccard(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	const aSet = new Set(a);
	const bSet = new Set(b);
	let common = 0;
	for (const token of aSet) if (bSet.has(token)) common++;
	const union = new Set([...aSet, ...bSet]).size;
	return union === 0 ? 0 : common / union;
}

function normalizeText(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(value: string | undefined): string[] {
	return [...new Set((value ?? "").toLowerCase().match(/[a-z0-9_/-]{3,}/g) ?? [])];
}

function memorySearchText(record: PiMemRecord): string {
	return `${record.summary}\n${record.content}\n${record.tags.join(" ")}\n${record.type}`.toLowerCase();
}
