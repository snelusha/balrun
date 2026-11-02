import { beforeAll, describe, expect, it } from "bun:test";

import { WasmBridge } from "../src/wasm-bridge";
import { discoverCases, findCorpusProblems, runCase, skipReason } from "./harness/corpus";
import { drivers } from "./harness/drivers";

const WASM_PATH = new URL("../dist/ballerina.wasm", import.meta.url).href;
const CASE_TIMEOUT_MS = 30_000;

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
			CASE_TIMEOUT_MS,
		);
	}
});
