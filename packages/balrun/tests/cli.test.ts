import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));

async function runCli(args: string[]) {
	const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
		stderr: "pipe",
		stdout: "pipe",
	});

	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);

	return { exitCode, stdout, stderr };
}

async function waitForOutput(stream: ReadableStream<Uint8Array>, text: string): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		output += decoder.decode(value, { stream: true });
		if (output.includes(text)) {
			void reader.cancel();
			return;
		}
	}

	throw new Error(
		`expected CLI output to contain ${JSON.stringify(text)}, got ${JSON.stringify(output)}`,
	);
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

	it("keeps listener programs alive until stopped", async () => {
		const listenerPath = fileURLToPath(new URL("./fixtures/listener.bal", import.meta.url));
		const proc = Bun.spawn([process.execPath, CLI_PATH, listenerPath], {
			stderr: "pipe",
			stdout: "pipe",
		});
		const [observedOutput, capturedOutput] = proc.stdout.tee();

		await waitForOutput(observedOutput, "Listener started.");
		proc.kill("SIGTERM");

		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(capturedOutput).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Graceful stop initiated.");
		expect(stderr).toBe("");
	});
});
