#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { Ballerina } from "../dist/index.mjs";

const [argument] = process.argv.slice(2);

if (argument === "--version") {
	const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
	process.stdout.write(`balrun ${version}\n`);
	process.exit(0);
}

if (argument === "--interpreter-version") {
	const version = await new Ballerina().getInterpreterVersion();
	process.stdout.write(`${JSON.stringify(version)}\n`);
	process.exit(0);
}

if (!argument) {
	process.stderr.write(
		"usage: balrun [--version | --interpreter-version | <source-file.bal> | <package-dir> | .]\n",
	);
	process.exit(1);
}

const path = argument;
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
