import { describe, expect, test } from "bun:test";

import { Ballerina } from "../src/ballerina";

import type { BallerinaCore, BallerinaRunOptions } from "../src/ballerina-core";
import type { FS } from "../src/fs/core";

const fsProxy: FS = {
	open: async () => null,
	stat: async () => null,
	readDir: async () => null,
	writeFile: async () => true,
	remove: async () => true,
	move: async () => true,
	mkdirAll: async () => true,
};

describe("Ballerina", () => {
	test("runs through the provided core with default options", async () => {
		const calls: Array<{
			fs: FS;
			path: string;
			options?: BallerinaRunOptions;
		}> = [];
		const core: BallerinaCore = {
			run: async (fs, path, options) => {
				calls.push({ fs, path, options });
				return null;
			},
		};

		const result = await new Ballerina({ core, fs: fsProxy }).run("main.bal");

		expect(result).toBeNull();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			fs: fsProxy,
			path: "main.bal",
			options: { colors: true, stdout: undefined, stderr: undefined },
		});
	});

	test("run options override constructor defaults", async () => {
		const stdout = { write: () => {} };
		const stderr = { write: () => {} };
		let received: BallerinaRunOptions | undefined;
		const core: BallerinaCore = {
			run: async (_fs, _path, options) => {
				received = options;
				return { error: "boom" };
			},
		};

		const result = await new Ballerina({
			core,
			fs: fsProxy,
			colors: false,
			stdout,
		}).run("main.bal", { colors: true, stderr });

		expect(result).toEqual({ error: "boom" });
		expect(received).toEqual({ colors: true, stdout, stderr });
	});

	test("init prepares the provided core and filesystem", async () => {
		const core: BallerinaCore = { run: async () => null };
		const ballerina = new Ballerina({ core, fs: fsProxy });

		await expect(ballerina.init()).resolves.toBe(ballerina);
	});
});
