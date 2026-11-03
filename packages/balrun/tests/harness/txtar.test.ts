import { describe, expect, it } from "bun:test";

import { formatTxtar, parseTxtar } from "./txtar";

describe("txtar", () => {
	it("parses sections", () => {
		expect(parseTxtar("-- a --\none\ntwo\n-- b --\n-- c --\nthree\n")).toEqual([
			{ name: "a", data: "one\ntwo\n" },
			{ name: "b", data: "" },
			{ name: "c", data: "three\n" },
		]);
	});

	it("round-trips lines that read as markers", () => {
		const files = [
			{ name: "stdout", data: "ok\n-- stderr --\n\\-- stderr --\n\\\\-- a --\n" },
			{ name: "stderr", data: "" },
		];
		expect(parseTxtar(formatTxtar(files))).toEqual(files);
	});

	it("ignores text before the first section", () => {
		expect(parseTxtar("comment\n-- a --\nx\n")).toEqual([{ name: "a", data: "x\n" }]);
	});

	it("does not treat a marker lookalike as a section", () => {
		const data = "-- a\n--b--\n x -- y --\n";
		expect(parseTxtar(`-- a --\n${data}`)).toEqual([{ name: "a", data }]);
	});

	it("keeps a last line without a newline", () => {
		expect(parseTxtar("-- a --\nx")).toEqual([{ name: "a", data: "x" }]);
	});

	it("round-trips, adding the final newline", () => {
		const text = formatTxtar([
			{ name: "stdout", data: "x" },
			{ name: "stderr", data: "" },
			{ name: "exitcode", data: "0\n" },
		]);
		expect(text).toBe("-- stdout --\nx\n-- stderr --\n-- exitcode --\n0\n");
		expect(parseTxtar(text)).toEqual([
			{ name: "stdout", data: "x\n" },
			{ name: "stderr", data: "" },
			{ name: "exitcode", data: "0\n" },
		]);
	});
});
