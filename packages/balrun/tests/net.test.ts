import { describe, expect, test } from "bun:test";

import { createNetPlatform } from "../src/net";

describe("NodeNetPlatform", () => {
	test("connects accepted TCP streams and transfers bytes", async () => {
		const platform = createNetPlatform();
		const listener = await platform.listen("tcp", "127.0.0.1:0");
		const address = await listener.address();
		const client = await platform.dial("tcp", `${address.address}:${address.port}`, "");
		const server = await listener.accept();

		await client.write(new TextEncoder().encode("ping"));
		const request = await server.read(16);
		expect(request).not.toBeNull();
		expect(new TextDecoder().decode(request!)).toBe("ping");
		await server.write(new TextEncoder().encode("pong"));
		const response = await client.read(16);
		expect(response).not.toBeNull();
		expect(new TextDecoder().decode(response!)).toBe("pong");

		await client.close();
		await server.close();
		await listener.close();
	});

	test("binds UDP listeners with an unspecified host", async () => {
		const listener = await createNetPlatform().listenPacket("udp", ":0");
		expect((await listener.localAddress()).port).toBeGreaterThan(0);
		await listener.close();
	});

	test("resolves, sends, and receives UDP datagrams", async () => {
		const platform = createNetPlatform();
		const receiver = await platform.listenPacket("udp", "127.0.0.1:0");
		const address = await receiver.localAddress();
		const sender = await platform.dialPacket("udp", `${address.address}:${address.port}`, "");
		const resolved = await platform.resolvePacketAddr("udp", "localhost:12345");
		expect(resolved.port).toBe(12345);

		await sender.writeTo(new TextEncoder().encode("ping"));
		const message = await receiver.readFrom(16);
		expect(message && new TextDecoder().decode(message.data)).toBe("ping");

		await expect(receiver.readFrom(16, Date.now() + 1)).rejects.toThrow(
			"[balrun]: network operation timed out",
		);

		await sender.close();
		await receiver.close();
	});
});
