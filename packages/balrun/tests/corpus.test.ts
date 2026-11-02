import { beforeAll, describe, expect, it } from "bun:test";

import { WasmBridge } from "../src/wasm-bridge";
import {
	CASE_TIMEOUT_MS,
	discoverCases,
	findCorpusProblems,
	runCase,
	skipReason,
} from "./harness/corpus";
import { drivers } from "./harness/drivers";

const WASM_PATH = new URL("../dist/ballerina.wasm", import.meta.url).href;

const cases = discoverCases();

describe("corpus", () => {
	let bridge: WasmBridge;

	beforeAll(async () => {
		bridge = await WasmBridge.load(WASM_PATH);
	});

	it("has no orphaned or conflicting cases", () => {
		expect(findCorpusProblems(cases, Object.keys(drivers))).toEqual([]);
	});

	for (const testCase of cases) {
		it.skipIf(skipReason(testCase) !== undefined)(
			testCase.name,
			() => runCase(bridge, testCase, drivers[testCase.name]),
			// A repeated case can use its whole limit on each run, plus the stop grace period.
			CASE_TIMEOUT_MS * ((drivers[testCase.name]?.runs ?? 1) + 1),
		);
	}
});
