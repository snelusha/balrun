import { describe, expect, it } from "bun:test";

import { checkSourceExpectations, runCase } from "./corpus.ts";

import type { WasmBridge } from "../../src/wasm-bridge.ts";
import type { CaseDriver, CorpusCase } from "./corpus.ts";

const COMPILE_ERROR = "error[SEMANTIC_ERROR]: incompatible type\n --> a.bal:2:17\n";
const PANIC = "error: boom\n        at main(a.bal:2)\n";

function check(name: string, exitcode: number, stderr: string, driver?: CaseDriver) {
	checkSourceExpectations({ name }, {}, { stdout: "", stderr, exitcode: String(exitcode) }, driver);
}

describe("checkSourceExpectations", () => {
	it("accepts each kind of case", () => {
		check("a-v", 0, "");
		check("a-e", 1, COMPILE_ERROR);
		check("a-p", 1, PANIC);
	});

	it("tells a compile error from a panic", () => {
		expect(() => check("a-e", 1, PANIC)).toThrow("should fail to compile");
		expect(() => check("a-p", 1, COMPILE_ERROR)).toThrow("should panic");
	});

	it("rejects output from a case that should fail to compile", () => {
		expect(() =>
			checkSourceExpectations(
				{ name: "a-e" },
				{ "a.bal": "// @output ran" },
				{ stdout: "ran\n", stderr: COMPILE_ERROR, exitcode: "1" },
			),
		).toThrow("should fail to compile");
	});

	it("only lets a case with a driver exit as stopped", () => {
		expect(() => check("a-v", 130, "")).toThrow("should exit cleanly");
		check("a-v", 130, "", { during: async () => {} });
	});
});

describe("runCase", () => {
	const testCase = {
		name: "core/hello-v",
		sourcePath: new URL("../corpus/bal/core/hello-v.bal", import.meta.url).pathname,
		goldenPath: "",
		isProject: false,
		browser: false,
		hosted: false,
	} satisfies CorpusCase;

	function fakeBridge(exit: Promise<number>) {
		const stops: string[] = [];
		const bridge = {
			run: () => exit,
			stop: (mode: string) => {
				stops.push(mode);
				return true;
			},
		} as unknown as WasmBridge;
		return { bridge, stops };
	}

	it("stops the program when its driver fails", async () => {
		let exit: (code: number) => void = () => {};
		const { bridge, stops } = fakeBridge(new Promise((resolve) => (exit = resolve)));
		const running = runCase(bridge, testCase, {
			during: async () => {
				queueMicrotask(() => exit(130));
				throw new Error("assertion failed");
			},
		});
		await expect(running).rejects.toThrow("assertion failed");
		expect(stops).toEqual(["immediate"]);
	});

	it("fails a driver still waiting when the program exits", async () => {
		const { bridge } = fakeBridge(Promise.resolve(0));
		const never = new Promise<void>(() => {});
		for (const during of [
			(context: { stdout(text: string): Promise<void> }) => context.stdout("ready"),
			(context: { listener(): Promise<unknown> }) => context.listener().then(() => {}),
			(context: { whileRunning(promise: Promise<void>): Promise<void> }) =>
				context.whileRunning(never),
		]) {
			await expect(runCase(bridge, testCase, { during })).rejects.toThrow(
				"program exited while its driver was waiting",
			);
		}
	});
});
