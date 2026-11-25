#!/usr/bin/env node

import { parseArgs } from "node:util";

import { Ballerina } from "../dist/node.mjs";

const USAGE = `usage: balrun [options] <source-file.bal | package-dir | .>

Options:
  -h, --help     Print this help message and exit
  -v, --version  Print version information and exit
`;

let args;
try {
	args = parseArgs({
		allowPositionals: true,
		options: {
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
} catch (error) {
	process.stderr.write(`error: ${error.message}\n\n${USAGE}`);
	process.exit(1);
}

const {
	values,
	positionals: [path],
} = args;

if (values.help) {
	process.stdout.write(USAGE);
	process.exit(0);
}

if (values.version) {
	try {
		const version = await new Ballerina().version();
		process.stdout.write(
			`balrun ${version.balrun}\nballerina-nutcracker ${version.interpreter.version} (${version.interpreter.revision})\n`,
		);
		process.exit(0);
	} catch (error) {
		process.stderr.write(`${error}\n`);
		process.exit(1);
	}
}

if (!path) {
	process.stderr.write(USAGE);
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
