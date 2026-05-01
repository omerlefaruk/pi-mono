import { randomBytes } from "node:crypto";

export function createTraceId(): string {
	return randomBytes(16).toString("hex");
}

export function createSpanId(): string {
	return randomBytes(8).toString("hex");
}

export function toOtelTime(timestampMs: number = Date.now()): string {
	return new Date(timestampMs).toISOString();
}
