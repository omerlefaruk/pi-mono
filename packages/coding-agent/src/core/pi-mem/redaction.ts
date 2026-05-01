const SECRET_PATTERNS: RegExp[] = [
	/\b(?:sk|rk|pk)_[A-Za-z0-9]{16,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g,
	/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
	/(?:password|token|secret|api[_-]?key)\s*[:=]\s*['"]?[^\s'",;]{6,}/gi,
];

export function redactLikelySecrets(input: string, mode: "off" | "mask" | "strict" = "mask"): string {
	if (mode === "off") return input;
	let output = input;
	for (const pattern of SECRET_PATTERNS) {
		output = output.replace(pattern, mode === "strict" ? "[REDACTED_SECRET]" : "[REDACTED]");
	}
	return output;
}
