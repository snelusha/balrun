import { describe, expect, test } from "bun:test";

import { Ballerina } from "../src/ballerina";
import type { BallerinaCore, BallerinaRunOptions } from "../src/ballerina-core";
import type { FS } from "../src/fs/core";
import { MemFS } from "./helpers";

describe("Ballerina", () => {
	test("runs through an injected core with the injected filesystem", async () => {
		const fs = new MemFS({ "main.bal": "" });
		const calls: Array<{
			fs: FS;
			path: string;
			options?: BallerinaRunOptions;
		}> = [];
		const core: BallerinaCore = {
			async run(proxy, path, options) {
				calls.push({ fs: proxy, path, options });
				return null;
			},
		};

		const result = await new Ballerina({ core, fs }).run("main.bal");

		expect(result).toBeNull();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.fs).toBe(fs);
		expect(calls[0]?.path).toBe("main.bal");
		expect(calls[0]?.options).toEqual({ colors: true });
	});

	test("merges constructor defaults with per-run options", async () => {
		const fs = new MemFS({ "main.bal": "" });
		const stdout = { write: () => undefined };
		const stderr = { write: () => undefined };
		let received: BallerinaRunOptions | undefined;
		const core: BallerinaCore = {
			async run(_proxy, _path, options) {
				received = options;
				return null;
			},
		};

		await new Ballerina({ core, fs, colors: true, stdout }).run("main.bal", {
			colors: false,
			stderr,
		});

		expect(received).toEqual({ colors: false, stdout, stderr });
	});
});
