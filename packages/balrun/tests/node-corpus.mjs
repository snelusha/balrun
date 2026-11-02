// `bun test` runs under Bun, whose `node:*` modules differ from Node.js in ways
// that have mattered here (see `integerPort` in src/net.ts). This runs the same
// corpus against the built package under Node.js.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { WasmBridge } from "../dist/index.mjs";
import { caseSourcePath, discoverCases, runCase, skipReason } from "./harness/corpus.ts";
import { drivers } from "./harness/drivers.ts";

const WASM_PATH = new URL("../dist/ballerina.wasm", import.meta.url).href;
const CLI_PATH = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const CLI_TIMEOUT_MS = 60_000;

const failures = [];
let passed = 0;
const bridge = await WasmBridge.load(WASM_PATH);

for (const testCase of discoverCases()) {
	const reason = skipReason(testCase);
	if (reason) {
		console.log(`skip ${testCase.name}: ${reason}`);
		continue;
	}
	try {
		await runCase(bridge, testCase, drivers[testCase.name]);
		passed++;
	} catch (error) {
		failures.push(testCase.name);
		console.error(`FAIL ${testCase.name}\n${error instanceof Error ? error.message : error}\n`);
	}
}

// A socket left open must not keep the real CLI process alive.
const child = spawn(process.execPath, [CLI_PATH, caseSourcePath("udp/leaves-client-open-v")], {
	stdio: "ignore",
});
const timeout = setTimeout(() => child.kill("SIGKILL"), CLI_TIMEOUT_MS);
const cliExit = await new Promise((resolve) => child.once("close", resolve));
clearTimeout(timeout);
if (cliExit === 0) passed++;
else {
	failures.push("cli exits with a socket left open");
	console.error(`FAIL CLI with a socket left open: exit ${cliExit}`);
}

console.log(`${passed} passed, ${failures.length} failed on Node.js ${process.version}`);
process.exit(failures.length > 0 ? 1 : 0);
