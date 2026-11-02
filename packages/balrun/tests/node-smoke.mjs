// `bun test` runs under Bun, whose `node:*` modules differ from Node.js in ways
// that have mattered here (see `integerPort` in src/net.ts). This runs the built
// CLI under Node.js, against real sockets.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/net.bal", import.meta.url));
const TIMEOUT_MS = 60_000;
const EXPECTED_OUTPUT = "udp ok\ntcp ok: true\n";

const ldapServer = createServer((socket) => {
	socket.on("data", (message) => {
		if (message[5] !== 0x60) return;
		socket.write(
			Uint8Array.of(
				0x30,
				0x0c,
				0x02,
				0x01,
				message[4],
				0x61,
				0x07,
				0x0a,
				0x01,
				0,
				0x04,
				0,
				0x04,
				0,
			),
		);
	});
	socket.on("error", () => {});
});
await new Promise((resolve) => ldapServer.listen(19611, "127.0.0.1", resolve));

const child = spawn(process.execPath, [CLI, FIXTURE], { stdio: ["ignore", "pipe", "inherit"] });
let stdout = "";
child.stdout.on("data", (chunk) => {
	stdout += chunk;
});
const timeout = setTimeout(() => {
	console.error(`CLI did not exit within ${TIMEOUT_MS}ms. Output so far:\n${stdout}`);
	child.kill("SIGKILL");
}, TIMEOUT_MS);
const exitCode = await new Promise((resolve) => child.once("close", resolve));
clearTimeout(timeout);
ldapServer.close();

if (exitCode !== 0 || stdout !== EXPECTED_OUTPUT) {
	console.error(`Expected exit 0 and ${JSON.stringify(EXPECTED_OUTPUT)}`);
	console.error(`Got exit ${exitCode} and ${JSON.stringify(stdout)}`);
	process.exit(1);
}
console.log(`Net smoke test passed on Node.js ${process.version}`);
process.exit(0);
