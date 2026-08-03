import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));

async function runCli(args: string[], signal?: NodeJS.Signals) {
	const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
		stderr: "pipe",
		stdout: "pipe",
	});

	if (!signal) {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	}

	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let stdout = "";
	let ready: (() => void) | undefined;
	const readyPromise = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const stdoutPromise = (async () => {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return stdout;
			stdout += decoder.decode(value, { stream: true });
			if (stdout.includes("ready\n")) ready?.();
		}
	})();

	try {
		await Promise.race([
			readyPromise,
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 10_000)),
		]);
		proc.kill(signal);
		const [exitCode, completedStdout, stderr] = await Promise.all([
			proc.exited,
			stdoutPromise,
			new Response(proc.stderr).text(),
		]);
		return { exitCode, stdout: completedStdout, stderr };
	} finally {
		proc.kill();
	}
}

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

describe("CLI", () => {
	it("prints usage and exits 1 when no path is provided", async () => {
		const result = await runCli([]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("usage: balrun");
	});

	it("runs a Ballerina file", async () => {
		const result = await runCli([fileURLToPath(new URL("./fixtures/hello.bal", import.meta.url))]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("Hello, Ballerina!\n");
		expect(result.stderr).toBe("");
	});

	it("prints runtime errors and exits 1", async () => {
		const missingPath = fileURLToPath(new URL("./fixtures/does-not-exist.bal", import.meta.url));
		const result = await runCli([missingPath]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error:");
		expect(result.stderr).toContain("file does not exist");
	});

	it("forwards SIGINT as a graceful stop", async () => {
		const result = await runCli([fixturePath("listener.bal")], "SIGINT");

		expect(result.exitCode).toBe(130);
		expect(result.stdout).toContain("graceful stop");
		expect(result.stderr).toBe("");
	});

	it("forwards SIGQUIT as an immediate stop", async () => {
		const result = await runCli([fixturePath("listener.bal")], "SIGQUIT");

		expect(result.exitCode).toBe(131);
		expect(result.stdout).toContain("immediate stop");
		expect(result.stderr).toBe("");
	});
});
