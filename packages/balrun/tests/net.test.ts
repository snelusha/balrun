import { describe, expect, it, spyOn } from "bun:test";
import { Socket } from "node:dgram";
import { readFileSync } from "node:fs";

import { createNetPlatform } from "../src/net";
import { WasmBridge } from "../src/wasm-bridge";
import { caseSourcePath, runCase, discoverCases } from "./harness/corpus";
import { drivers } from "./harness/drivers";
import { MemFS } from "./memfs";

import type { NetPlatform } from "../src/net";

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
		const payload = new Uint8Array(64 * 1024 * 1024).fill(7);
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

	it("sends to this machine when a datagram has no host", async () => {
		const server = await platform.bindDatagram({ host: "", port: 0 });
		const received = server.receive();
		await server.send(new TextEncoder().encode("self"), "", server.local.port);
		expect(new TextDecoder().decode((await received).data)).toBe("self");
		await server.close();
	});

	it("closes a datagram socket that fails to bind", async () => {
		const taken = await platform.bindDatagram({ host: "127.0.0.1", port: 0 });
		const close = spyOn(Socket.prototype, "close");
		try {
			await expect(
				platform.bindDatagram({ host: "127.0.0.1", port: taken.local.port }),
			).rejects.toMatchObject({ code: "EADDRINUSE" });
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			close.mockRestore();
		}
		await taken.close();
	});

	it("exposes the host's CA bundle", async () => {
		expect((await platform.rootCertificates()).length).toBeGreaterThan(0);
	});
});

describe("host CA bundle", () => {
	const WASM_PATH = new URL("../dist/ballerina.wasm", import.meta.url).href;
	const prototype = Object.getPrototypeOf(createNetPlatform()) as NetPlatform;

	function corpusCase(name: string) {
		const testCase = discoverCases().find((candidate) => candidate.name === name);
		if (!testCase) throw new Error(`no corpus case ${name}`);
		return testCase;
	}

	it("isn't needed for a custom CA", async () => {
		const roots = spyOn(prototype, "rootCertificates");
		try {
			const name = "hosted/ldap/tls-custom-ca-v";
			await runCase(await WasmBridge.load(WASM_PATH), corpusCase(name), drivers[name]);
			expect(roots).not.toHaveBeenCalled();
		} finally {
			roots.mockRestore();
		}
	});

	it("is retried after a failed load", async () => {
		const name = "hosted/ldap/tls-unknown-ca-v";
		const bridge = await WasmBridge.load(WASM_PATH);
		const entry = "tls-unknown-ca-v.bal";
		const source = readFileSync(caseSourcePath(name), "utf8");
		const firstRun = async () => {
			let stdout = "";
			await bridge.run(new MemFS({ [entry]: source }), entry, {
				colors: false,
				stdout: {
					write: (chunk) => {
						stdout += chunk;
					},
				},
			});
			return stdout.trim();
		};

		const cleanup = await drivers[name]?.setup?.();
		const roots = spyOn(prototype, "rootCertificates").mockRejectedValueOnce(
			new Error("no bundle"),
		);
		try {
			// The case prints whether the failure was about the certificate.
			expect(await firstRun()).toBe("false");
			expect(await firstRun()).toBe("true");
			expect(roots).toHaveBeenCalledTimes(2);
		} finally {
			roots.mockRestore();
			await cleanup?.();
		}
	});
});
