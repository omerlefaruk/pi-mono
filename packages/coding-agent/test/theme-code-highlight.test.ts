import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, it } from "vitest";
import { highlightCode, initTheme, theme } from "../src/modes/interactive/theme/theme.js";

describe("highlightCode", () => {
	beforeEach(() => {
		process.env.COLORTERM = "truecolor";
		initTheme("dark");
	});

	it("applies the code-block color to syntax-highlighted text that cli-highlight leaves plain", () => {
		const [line] = highlightCode("const value = foo;", "javascript");
		const baseAnsi = theme.getFgAnsi("mdCodeBlock");

		expect(stripAnsi(line)).toBe("const value = foo;");
		expect(line.startsWith(baseAnsi)).toBe(true);
		expect(line).toContain(`${theme.getFgAnsi("syntaxKeyword")}const\x1b[39m${baseAnsi} value = foo;`);
	});

	it("uses the code-block color for unhighlighted languages too", () => {
		const [line] = highlightCode("plain command output", "not-a-real-language");

		expect(stripAnsi(line)).toBe("plain command output");
		expect(line).toBe(theme.fg("mdCodeBlock", "plain command output"));
	});
});
