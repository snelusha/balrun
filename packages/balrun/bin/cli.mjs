#!/usr/bin/env node

import { Ballerina } from "../dist/index.mjs";

const path = process.argv[2];

if (!path) {
	process.stderr.write("usage: balrun [<source-file.bal> | <package-dir> | .]\n");
	process.exit(1);
}

const keepAlive = setInterval(() => {}, 1_000);

const ballerina = new Ballerina({
	colors: Boolean(process.stderr.isTTY),
	stderr: process.stderr,
});
const signalHandlers = [
	["SIGINT", "graceful"],
	["SIGTERM", "graceful"],
	["SIGQUIT", "immediate"],
].map(([name, mode]) => {
	const handler = () => void ballerina.stop(mode);
	process.on(name, handler);
	return [name, handler];
});

let exitCode;
try {
	exitCode = await ballerina.run(path);
} catch (error) {
	process.stderr.write(`${error}\n`);
	exitCode = 1;
} finally {
	clearInterval(keepAlive);
	for (const [name, handler] of signalHandlers) process.off(name, handler);
}

process.exitCode = exitCode;
