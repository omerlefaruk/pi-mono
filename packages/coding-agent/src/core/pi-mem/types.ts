export type PiMemRecordType =
	| "observation"
	| "decision"
	| "fact"
	| "todo"
	| "note"
	| "preference"
	| "fix"
	| "failed_attempt";

export interface PiMemCitation {
	traceId?: string;
	spanId?: string;
	rootSpanId?: string;
	toolName?: string;
	toolCallId?: string;
}

export interface PiMemRecord {
	id: string;
	type: PiMemRecordType;
	summary: string;
	content: string;
	tags: string[];
	namespace?: string;
	projectId?: string;
	cwd: string;
	sessionId: string;
	sessionFile: string;
	createdAt: number;
	updatedAt: number;
	confidence: number;
	importance: number;
	source: string;
	citations?: PiMemCitation[];
	privacy: "public" | "private" | "sensitive";
	pinned?: boolean;
	stale?: boolean;
	wrong?: boolean;
	usefulCount?: number;
	wrongCount?: number;
	staleCount?: number;
}

export interface PiMemSettings {
	enabled?: boolean;
	autoExtract?: boolean;
	autoInject?: boolean;
	maxInjected?: number;
	maxQueryResults?: number;
	redactMode?: "off" | "mask" | "strict";
	namespaces?: string[];
	storePath?: string;
	storageBackend?: "jsonl" | "sqlite" | "auto";
	projectId?: string;
	extractionMode?: "heuristic" | "model";
	extractionModel?: string;
}

export interface PiMemResolvedSettings {
	enabled: boolean;
	autoExtract: boolean;
	autoInject: boolean;
	maxInjected: number;
	maxQueryResults: number;
	redactMode: "off" | "mask" | "strict";
	namespaces: string[];
	storePath?: string;
	storageBackend: "jsonl" | "sqlite" | "auto";
	projectId?: string;
	extractionMode: "heuristic" | "model";
	extractionModel?: string;
}

export interface PiMemSearchInput {
	query?: string;
	tags?: string[];
	namespace?: string;
	namespaces?: string[];
	projectId?: string;
	cwd?: string;
	includeSensitive?: boolean;
	limit?: number;
}
