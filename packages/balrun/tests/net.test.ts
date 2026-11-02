import { beforeAll, describe, expect, it } from "bun:test";
import { createSocket } from "node:dgram";
import { createServer, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { createServer as createTLSServer } from "node:tls";

import { createNetPlatform } from "../src/net";
import { WasmBridge } from "../src/wasm-bridge";
import { MemFS } from "./memfs";

import type { NetPlatform } from "../src/net";

const WASM_PATH = new URL("../dist/ballerina.wasm", import.meta.url).href;

const fixture = (name: string) =>
	Bun.file(new URL(`./fixtures/tls/${name}`, import.meta.url)).text();

const hasIPv6Loopback = Object.values(networkInterfaces())
	.flat()
	.some((address) => address?.address === "::1");

const ECHO_SERVICE = `
service class EchoService {
    *udp:Service;

    remote function onBytes(readonly & byte[] data) returns byte[] {
        return data;
    }
}
`;

function program(body: string, declarations = ""): string {
	return `
import ballerina/io;
import ballerina/udp;
${declarations}
public function main() returns error? {
${body}
}
`;
}

function ldapProgram(config: string): string {
	return `
import ballerina/io;
import ballerina/ldap;

public function main() returns error? {
    ldap:Client|ldap:Error c = new (${config});
    if c is ldap:Error {
        io:println("error: ", c.message());
        return;
    }
    boolean connected = check c->isConnected();
    io:println("connected: ", connected);
    check c->close();
}
`;
}

function answerLdapBinds(socket: Socket): void {
	socket.on("data", (data) => {
		const message = Buffer.from(data);
		if (message[0] !== 0x30) return;
		const messageId = message.readUInt8(4);
		if (message[5] !== 0x60) return;
		socket.write(
			Uint8Array.of(0x30, 0x0c, 0x02, 0x01, messageId, 0x61, 0x07, 0x0a, 0x01, 0, 0x04, 0, 0x04, 0),
		);
	});
	socket.on("error", () => {});
}

function serverPort(server: { address(): unknown }): number {
	return (server.address() as { port: number }).port;
}

describe("Net PAL", () => {
	let bridge: WasmBridge;

	beforeAll(async () => {
		bridge = await WasmBridge.load(WASM_PATH);
	});

	async function run(source: string, files: Record<string, string> = {}) {
		const output: string[] = [];
		const write = { write: (chunk: string) => output.push(chunk) };
		const exitCode = await bridge.run(new MemFS({ "main.bal": source, ...files }), "main.bal", {
			stdout: write,
			stderr: write,
			colors: false,
		});
		return { exitCode, output: output.join("") };
	}

	describe("udp", () => {
		it("exchanges datagrams through a listener, Client, and ConnectClient", async () => {
			const { exitCode, output } = await run(
				program(
					`
    udp:Listener server = check new (19601);
    check server.attach(new EchoService());
    check server.'start();

    udp:Client c = check new ({timeout: 5});
    check c->sendDatagram({remoteHost: "127.0.0.1", remotePort: 19601, data: "hello".toBytes()});
    readonly & udp:Datagram echoed = check c->receiveDatagram();
    io:println(check string:fromBytes(echoed.data), " ", echoed.remoteHost, ":", echoed.remotePort);
    check c->close();
    udp:Error? afterClose = c->sendDatagram({remoteHost: "127.0.0.1", remotePort: 19601, data: []});
    io:println(afterClose is udp:Error);
    udp:Error? closeTwice = c->close();
    io:println(closeTwice is ());

    udp:ConnectClient cc = check new ("localhost", 19601, {timeout: 5});
    check cc->writeBytes("world".toBytes());
    readonly & byte[] reply = check cc->readBytes();
    io:println(check string:fromBytes(reply));
    check cc->close();
    udp:Error? writeAfterClose = cc->writeBytes("x".toBytes());
    io:println(writeAfterClose is udp:Error);

    check server.gracefulStop();
`,
					ECHO_SERVICE,
				),
			);
			expect(output).toBe("hello 127.0.0.1:19601\ntrue\ntrue\nworld\ntrue\n");
			expect(exitCode).toBe(0);
		});

		it.if(hasIPv6Loopback)("reaches IPv6 peers", async () => {
			const { output } = await run(
				program(
					`
    udp:Listener server = check new (19602);
    check server.attach(new EchoService());
    check server.'start();
    udp:ConnectClient cc = check new ("::1", 19602, {timeout: 5});
    check cc->writeBytes("six".toBytes());
    readonly & byte[] reply = check cc->readBytes();
    io:println(check string:fromBytes(reply));
    check cc->close();
    check server.immediateStop();
`,
					ECHO_SERVICE,
				),
			);
			expect(output).toBe("six\n");
		});

		it("reports read timeouts", async () => {
			const { output } = await run(
				program(`
    udp:Client c = check new ({timeout: 0.1});
    readonly & udp:Datagram|udp:Error received = c->receiveDatagram();
    io:println(received is udp:Error ? received.message() : "received");
    check c->close();
`),
			);
			expect(output).toBe("Read timed out\n");
		});

		it("reports a refused peer on a connected socket", async () => {
			const { output } = await run(
				program(`
    udp:ConnectClient cc = check new ("127.0.0.1", 19603, {timeout: 2});
    check cc->writeBytes("x".toBytes());
    readonly & byte[]|udp:Error received = cc->readBytes();
    io:println(received is udp:Error ? received.message() : "received");
    check cc->close();
`),
			);
			expect(output).toContain("connection refused");
		});

		it("reports a port that is already bound", async () => {
			const { output } = await run(
				program(
					`
    udp:Listener first = check new (19604);
    check first.attach(new EchoService());
    check first.'start();
    udp:Listener second = check new (19604);
    check second.attach(new EchoService());
    error? started = second.'start();
    io:println(started is error ? started.message() : "started");
    check first.gracefulStop();
`,
					ECHO_SERVICE,
				),
			);
			expect(output).toContain("Unable to initialize UDP Listener");
			expect(output).toContain("address already in use");
		});

		it("serves external peers until stopped", async () => {
			const source = `
import ballerina/udp;
${ECHO_SERVICE}
listener udp:Listener server = new (19605);

function init() returns error? {
    check server.attach(new EchoService());
}
`;
			const running = run(source);
			const peer = createSocket("udp4");
			const reply = new Promise<string>((resolve) =>
				peer.once("message", (message) => resolve(message.toString())),
			);
			const retry = setInterval(() => peer.send("ping", 19605, "127.0.0.1"), 50);
			try {
				expect(await reply).toBe("ping");
			} finally {
				clearInterval(retry);
				peer.close();
			}
			expect(bridge.stop("graceful")).toBe(true);
			expect((await running).exitCode).toBe(130);
		});

		it("releases sockets a run leaves open", async () => {
			const leaky = program(
				`
    udp:Listener server = check new (19606);
    check server.attach(new EchoService());
    check server.'start();
    udp:Client _ = check new ();
    io:println("ran");
    panic error("exit without cleanup");
`,
				ECHO_SERVICE,
			);
			expect((await run(leaky)).output).toContain("ran");
			const second = await run(leaky);
			expect(second.output).toContain("ran");
			expect(second.output).not.toContain("address already in use");
		});
	});

	describe("ldap over tcp", () => {
		it("binds over plain TCP", async () => {
			const server = createServer({ allowHalfOpen: true }, answerLdapBinds);
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			try {
				const { output } = await run(
					ldapProgram(
						`{hostName: "127.0.0.1", port: ${serverPort(server)}, domainName: "cn=admin", password: "pw"}`,
					),
				);
				expect(output).toBe("connected: true\n");
			} finally {
				server.close();
			}
		});

		it("reports a refused connection", async () => {
			const { output } = await run(
				ldapProgram(`{hostName: "127.0.0.1", port: 19607, domainName: "cn=admin", password: "pw"}`),
			);
			expect(output).toContain("failed to connect to 127.0.0.1:19607");
			expect(output).toContain("connection refused");
		});

		describe("tls", () => {
			let cert: string;
			let key: string;

			beforeAll(async () => {
				cert = await fixture("server-cert.pem");
				key = await fixture("server-key.pem");
			});

			async function connect(hostName: string, secureSocket: string) {
				const server = createTLSServer({ cert, key }, answerLdapBinds);
				server.on("tlsClientError", () => {});
				await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
				try {
					const { output } = await run(
						ldapProgram(
							`{hostName: "${hostName}", port: ${serverPort(server)}, domainName: "cn=admin", password: "pw", clientSecureSocket: ${secureSocket}}`,
						),
						{ "ca.pem": cert },
					);
					return output;
				} finally {
					server.close();
				}
			}

			it("verifies the server against a custom CA", async () => {
				expect(await connect("localhost", `{cert: "ca.pem"}`)).toBe("connected: true\n");
			});

			it("rejects a hostname the certificate does not cover", async () => {
				expect(await connect("127.0.0.1", `{cert: "ca.pem"}`)).toContain("x509");
			});

			it("can skip only the hostname check", async () => {
				expect(await connect("127.0.0.1", `{cert: "ca.pem", verifyHostName: false}`)).toBe(
					"connected: true\n",
				);
			});

			it("rejects a certificate from an unknown CA", async () => {
				expect(await connect("localhost", "{}")).toContain("x509");
			});
		});
	});

	describe("without host sockets", () => {
		async function runInBrowser(source: string) {
			const original = globalThis.process;
			// @ts-expect-error simulates a browser, where `process` doesn't exist
			globalThis.process = undefined;
			try {
				return await run(source);
			} finally {
				globalThis.process = original;
			}
		}

		it("connects sockets within the run", async () => {
			const { output } = await runInBrowser(
				program(
					`
    udp:Listener server = check new (19608);
    check server.attach(new EchoService());
    check server.'start();
    udp:ConnectClient cc = check new ("localhost", 19608, {timeout: 5});
    check cc->writeBytes("loop".toBytes());
    readonly & byte[] reply = check cc->readBytes();
    io:println(check string:fromBytes(reply));
    check cc->close();
    check server.gracefulStop();
`,
					ECHO_SERVICE,
				),
			);
			expect(output).toBe("loop\n");
		});

		it("explains why other hosts are unreachable", async () => {
			const { output } = await runInBrowser(
				program(`
    udp:ConnectClient|udp:Error cc = new ("example.com", 19609, {});
    io:println(cc is udp:Error ? cc.message() : "connected");
`),
			);
			expect(output).toContain("sockets are unavailable in this environment");
		});
	});
});

describe("NodeNetPlatform", () => {
	const platform = createNetPlatform() as NetPlatform;

	async function loopbackPair() {
		const listener = await platform.listen({ host: "127.0.0.1", port: 0 });
		const accepted = listener.accept();
		const client = await platform.connect({ host: "127.0.0.1", port: listener.local.port });
		return { listener, client, server: await accepted };
	}

	it("transfers more than the socket buffers hold, with a slow reader", async () => {
		const { listener, client, server } = await loopbackPair();
		const payload = new Uint8Array(8 * 1024 * 1024).fill(7);
		const written = client.write(payload);
		let received = 0;
		let settled = false;
		void written.then(() => {
			settled = true;
		});

		const first = await server.read();
		received += first?.byteLength ?? 0;
		await Bun.sleep(100);
		expect(settled).toBe(false);

		while (received < payload.byteLength) {
			const chunk = await server.read();
			if (!chunk) break;
			received += chunk.byteLength;
		}
		await written;
		expect(received).toBe(payload.byteLength);

		await client.close();
		expect(await server.read()).toBeNull();
		await server.close();
		await listener.close();
	});

	it("rejects pending calls on close", async () => {
		const { listener, client, server } = await loopbackPair();
		const codeOf = (error: { code: string }) => error.code;
		const read = client.read().catch(codeOf);
		const accept = listener.accept().catch(codeOf);
		await client.close();
		await listener.close();
		await server.close();
		expect(await read).toBe("ECLOSED");
		expect(await accept).toBe("ECLOSED");
	});

	it("aborts a pending connect", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		expect(
			platform.connect({ host: "127.0.0.1", port: 1, signal: controller.signal }),
		).rejects.toThrow("cancelled");
	});

	it("hides mapped addresses on a dual-stack datagram socket", async () => {
		const dual = await platform.bindDatagram({ host: "", port: 0 });
		const client = await platform.connectDatagram({ host: "127.0.0.1", port: dual.local.port });
		const received = dual.receive();
		await client.send(new TextEncoder().encode("hi"));
		const datagram = await received;
		expect(datagram.host).toBe("127.0.0.1");

		const reply = client.receive();
		await dual.send(new TextEncoder().encode("yo"), datagram.host, datagram.port);
		expect(new TextDecoder().decode((await reply).data)).toBe("yo");
		await client.close();
		await dual.close();
	});

	it("reports each datagram socket error once", async () => {
		const dead = await platform.bindDatagram({ host: "127.0.0.1", port: 0 });
		const port = dead.local.port;
		await dead.close();

		const socket = await platform.connectDatagram({ host: "127.0.0.1", port });
		await socket.send(new Uint8Array(1));
		await expect(socket.receive()).rejects.toMatchObject({ code: "ECONNREFUSED" });
		const next = socket.receive().then(
			() => "settled",
			(error: { code: string }) => error.code,
		);
		expect(await Promise.race([next, Bun.sleep(100).then(() => "pending")])).toBe("pending");
		await socket.close();
		expect(await next).toBe("ECLOSED");
	});

	it("exposes the host's CA bundle", async () => {
		expect((await platform.rootCertificates()).length).toBeGreaterThan(0);
	});
});
