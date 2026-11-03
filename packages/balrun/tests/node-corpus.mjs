// `bun test` runs under Bun, whose `node:*` modules differ from Node.js in ways
// that have mattered here (see `integerPort` in src/net.ts). This runs the same
// corpus against the built package under Node.js.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { WasmBridge } from "../dist/index.mjs";
import { caseSourcePath, certPath, discoverCases, runCase, skipReason } from "./harness/corpus.ts";
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

// Certificates the host trusts through NODE_EXTRA_CA_CERTS must reach the interpreter.
const unknownCA = "hosted/ldap/tls-unknown-ca-v";
const stopServer = await drivers[unknownCA].setup();
const trusting = spawn(process.execPath, [CLI_PATH, caseSourcePath(unknownCA)], {
	env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath("server-cert.pem") },
	stdio: ["ignore", "pipe", "inherit"],
});
let trustingOutput = "";
trusting.stdout.on("data", (chunk) => {
	trustingOutput += chunk;
});
const trustingTimeout = setTimeout(() => trusting.kill("SIGKILL"), CLI_TIMEOUT_MS);
await new Promise((resolve) => trusting.once("close", resolve));
clearTimeout(trustingTimeout);
await stopServer();
// The case prints whether the connection failed over its certificate.
if (trustingOutput.trim() === "false") passed++;
else {
	failures.push("NODE_EXTRA_CA_CERTS is trusted");
	console.error(`FAIL NODE_EXTRA_CA_CERTS: printed ${trustingOutput}`);
}

console.log(`${passed} passed, ${failures.length} failed on Node.js ${process.version}`);
process.exit(failures.length > 0 ? 1 : 0);
