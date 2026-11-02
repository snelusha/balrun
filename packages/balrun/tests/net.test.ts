import { describe, expect, it } from "bun:test";

import { createNetPlatform } from "../src/net";

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

	it("exposes the host's CA bundle", async () => {
		expect((await platform.rootCertificates()).length).toBeGreaterThan(0);
	});
});
