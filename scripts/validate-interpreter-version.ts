#!/usr/bin/env bun

import { $ } from "bun";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type InterpreterVersion = {
	version: string | null;
	commit: string;
};

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const metadataPath = join(repositoryRoot, "packages/ballerina-wasm/interpreter.json");
const submodulePath = join(repositoryRoot, "packages/ballerina-wasm/ballerina");
const metadata = (await Bun.file(metadataPath).json()) as InterpreterVersion;

function fail(message: string): never {
	throw new Error(`[interpreter-version]: ${message}`);
}

if (metadata.version !== null && !/^v\S+$/.test(metadata.version))
	fail("`version` must be a tag beginning with `v` or null");
if (!/^[0-9a-f]{40}$/.test(metadata.commit))
	fail("`commit` must be a 40-character lowercase Git SHA");

const commit = (await $`git -C ${submodulePath} rev-parse HEAD`.text()).trim();
if (commit !== metadata.commit)
	fail(`metadata commit ${metadata.commit} does not match submodule HEAD ${commit}`);

if (metadata.version !== null) {
	const tagRef = `refs/tags/${metadata.version}`;
	const tagExists =
		(await $`git -C ${submodulePath} show-ref --verify --quiet ${tagRef}`.quiet()) === 0;
	if (tagExists) {
		const tags = (await $`git -C ${submodulePath} tag --points-at ${commit}`.text())
			.split("\n")
			.map((tag) => tag.trim());
		if (!tags.includes(metadata.version))
			fail(`tag ${metadata.version} does not point at ${commit}`);
	}
}
