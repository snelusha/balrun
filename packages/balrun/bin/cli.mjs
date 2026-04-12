#!/usr/bin/env node

import { Ballerina } from "../dist/index.mjs";

const path = process.argv[2];

if (!path) {
	process.stderr.write(
		"usage: balrun [<source-file.bal> | <package-dir> | .]\n",
	);
	process.exit(1);
}

const result = await new Ballerina({
	colors: Boolean(process.stderr.isTTY),
}).run(path);

if (result) {
	process.stderr.write(`error: ${result.error}\n`);
	process.exit(1);
}
