#!/usr/bin/env node

import { Ballerina } from "../dist/index.mjs";

const path = process.argv[2];

if (!path) {
	process.stderr.write("usage: balrun [<source-file.bal> | <package-dir> | .]\n");
	process.exit(1);
}

const ballerina = new Ballerina({
	colors: Boolean(process.stderr.isTTY),
	stdout: process.stdout,
	stderr: process.stderr,
});

let stopping = false;
function onSignal(signal) {
	const mode = stopping ? "immediate" : "graceful";
	stopping = true;
	void ballerina.stop(mode).then((accepted) => {
		if (accepted) return;
		process.off(signal, onSignal);
		process.kill(process.pid, signal);
	});
}

process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

// A Ballerina listener waits in WASM and does not retain a JavaScript event-loop handle.
// Keep the CLI alive until the run completes or a signal stops it.
const keepAlive = setInterval(() => undefined, 2 ** 31 - 1);

try {
	const result = await ballerina.run(path);
	if (result) {
		process.stderr.write(`error: ${result.error}\n`);
		process.exitCode = 1;
	}
} finally {
	clearInterval(keepAlive);
	process.off("SIGINT", onSignal);
	process.off("SIGTERM", onSignal);
}
