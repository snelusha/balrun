import { createSocket } from "node:dgram";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:tls";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "bun:test";

import { TEST_CERT, TEST_KEY } from "./fixtures/net-tls";

// These run Ballerina through the built WASM, covering net_wasm.go, which net.test.ts can't reach.
const CLI_PATH = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));

let directory: string | undefined;

afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

async function runBallerina(source: string, files: Record<string, string> = {}) {
	directory = await mkdtemp(join(tmpdir(), "balrun-net-"));
	for (const [name, content] of Object.entries({ ...files, "main.bal": source })) {
		await writeFile(join(directory, name), content);
	}
	const proc = Bun.spawn([process.execPath, CLI_PATH, "main.bal"], {
		cwd: directory,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("net through WASM", () => {
	test("UDP round trip, repeat close, and read after close", async () => {
		const peer = createSocket("udp4");
		peer.on("message", (data, info) => peer.send(data, info.port, info.address));
		await new Promise<void>((resolve) => peer.bind(0, "127.0.0.1", resolve));

		const { exitCode, stdout, stderr } = await runBallerina(`
import ballerina/io;
import ballerina/udp;

public function main() returns error? {
    udp:ConnectClient c = check new ("127.0.0.1", ${peer.address().port});
    check c->writeBytes("hello".toBytes());
    readonly & byte[] r = check c->readBytes();
    io:println(string:fromBytes(r));
    check c->close();
    check c->close();
    var e = c->readBytes();
    io:println(e is error ? e.message() : "no error");
}
`);
		peer.close();

		expect(stderr).toBe("");
		expect(stdout).toBe("hello\nSocket connection already closed.\n");
		expect(exitCode).toBe(0);
	}, 30_000);

	test("exits after a read timeout when the program leaves its socket open", async () => {
		const peer = createSocket("udp4");
		await new Promise<void>((resolve) => peer.bind(0, "127.0.0.1", resolve));

		const { exitCode, stdout } = await runBallerina(`
import ballerina/io;
import ballerina/udp;

public function main() returns error? {
    udp:ConnectClient c = check new ("127.0.0.1", ${peer.address().port}, {timeout: 0.1});
    var r = c->readBytes();
    io:println(r is error ? r.message() : "no error");
}
`);
		peer.close();

		expect(stdout).toBe("Read timed out\n");
		expect(exitCode).toBe(0);
	}, 30_000);

	test("dials TLS with a trusted CA without crashing the runtime", async () => {
		let established = false;
		const server = createServer({ cert: TEST_CERT, key: TEST_KEY }, (socket) => {
			established = true;
			socket.on("error", () => undefined);
			socket.on("data", () => socket.destroy());
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;

		const { exitCode, stdout } = await runBallerina(
			`
import ballerina/io;
import ballerina/ldap;

public function main() {
    ldap:Client|ldap:Error c = new ({
        hostName: "localhost",
        port: ${port},
        domainName: "cn=a",
        password: "b",
        clientSecureSocket: {cert: "cert.pem"}
    });
    io:println(c is error ? c.message() : "connected");
}
`,
			{ "cert.pem": TEST_CERT },
		);
		server.close();

		expect(established).toBe(true);
		expect(stdout).toContain("unable to read LDAP response packet");
		expect(exitCode).toBe(0);
	}, 30_000);
});
