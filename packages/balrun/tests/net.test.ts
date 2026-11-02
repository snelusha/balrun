import { createSocket } from "node:dgram";
import { afterEach, describe, expect, test } from "bun:test";

import { createNetPlatform } from "../src/net";
import type { NetPlatform, SocketAddress, TLSOptions } from "../src/net";
import { TEST_CERT, TEST_KEY } from "./fixtures/net-tls";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array | null | undefined) => new TextDecoder().decode(data ?? undefined);
const hostPort = ({ address, port }: SocketAddress) => `${address}:${port}`;

const CLOSED = "[balrun]: use of closed network connection";
const TIMED_OUT = "[balrun]: network operation timed out";

const serverTLS: TLSOptions = { cert: encode(TEST_CERT), key: encode(TEST_KEY) };
const trustTestCA: TLSOptions = { ca: encode(TEST_CERT) };

let platform: NetPlatform;

afterEach(async () => {
	await platform?.closeAll();
});

function newPlatform(): NetPlatform {
	platform = createNetPlatform();
	return platform;
}

async function canBindIPv6(): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createSocket("udp6");
		socket.once("error", () => resolve(false));
		socket.bind(0, "::1", () => socket.close(() => resolve(true)));
	});
}

describe("TCP", () => {
	test("connects accepted streams and transfers bytes", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const client = await net.dial("tcp", hostPort(await listener.address()), "");
		const server = await listener.accept();

		await client.write(encode("ping"));
		expect(decode(await server.read(16))).toBe("ping");
		await server.write(encode("pong"));
		expect(decode(await client.read(16))).toBe("pong");

		await client.close();
		expect(await server.read(16)).toBeNull();
		await server.close();
		await listener.close();
	});

	test("splits a chunk across reads smaller than it", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const client = await net.dial("tcp", hostPort(await listener.address()), "");
		const server = await listener.accept();

		await client.write(encode("abcdef"));
		expect(decode(await server.read(4))).toBe("abcd");
		expect(decode(await server.read(4))).toBe("ef");
	});

	test("closing a listener leaves accepted connections open and rejects a blocked accept", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const client = await net.dial("tcp", hostPort(await listener.address()), "");
		const server = await listener.accept();
		const blocked = listener.accept();

		await listener.close();

		await expect(blocked).rejects.toThrow(CLOSED);
		await expect(listener.accept()).rejects.toThrow(CLOSED);
		await client.write(encode("still open"));
		expect(decode(await server.read(16))).toBe("still open");
	});

	test("closing a stream fails a blocked read and repeat closes with the closed error", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const client = await net.dial("tcp", hostPort(await listener.address()), "");
		const blocked = client.read(16);

		await client.close();

		await expect(blocked).rejects.toThrow(CLOSED);
		await expect(client.read(16)).rejects.toThrow(CLOSED);
		await expect(client.write(encode("x"))).rejects.toThrow(CLOSED);
		await expect(client.close()).rejects.toThrow(CLOSED);
	});

	test("a new read deadline interrupts a read already in flight", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const client = await net.dial("tcp", hostPort(await listener.address()), "");
		const blocked = client.read(16);

		client.setReadDeadline(Date.now() + 5);

		await expect(blocked).rejects.toThrow(TIMED_OUT);
		await expect(client.read(16)).rejects.toThrow(TIMED_OUT);
	});

	test("clearing a deadline makes the handle usable again", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const client = await net.dial("tcp", hostPort(await listener.address()), "");
		const server = await listener.accept();

		client.setReadDeadline(Date.now() - 1);
		await expect(client.read(16)).rejects.toThrow(TIMED_OUT);
		client.setReadDeadline();
		await server.write(encode("pong"));
		expect(decode(await client.read(16))).toBe("pong");
	});

	test("a far-future deadline does not fire immediately", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const client = await net.dial("tcp", hostPort(await listener.address()), "");
		const server = await listener.accept();

		client.setReadDeadline(Date.now() + 2 ** 33);
		await Bun.sleep(5);
		await server.write(encode("pong"));
		expect(decode(await client.read(16))).toBe("pong");
	});

	test("an expired write deadline fails writes", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const client = await net.dial("tcp", hostPort(await listener.address()), "");

		client.setWriteDeadline(Date.now() - 1);
		await expect(client.write(encode("x"))).rejects.toThrow(TIMED_OUT);
	});

	test("rejects dials that are refused or already aborted", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const address = hostPort(await listener.address());
		await listener.close();
		await Bun.sleep(50);

		await expect(net.dial("tcp", address, "")).rejects.toThrow();
		await expect(net.dial("tcp", address, "", undefined, AbortSignal.abort())).rejects.toThrow();
	});

	test("aborting stops a dial that is waiting on the handshake", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const controller = new AbortController();
		const dial = net.dial(
			"tcp",
			hostPort(await listener.address()),
			"",
			trustTestCA,
			controller.signal,
		);

		await Bun.sleep(5);
		controller.abort();

		await expect(dial).rejects.toThrow("network dial cancelled");
	});
});

describe("TLS", () => {
	test("completes a round trip against a trusted CA", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0", serverTLS);
		const { port } = await listener.address();
		const client = await net.dial("tcp", `localhost:${port}`, "", trustTestCA);
		const server = await listener.accept();

		await client.write(encode("ping"));
		expect(decode(await server.read(16))).toBe("ping");
		await server.write(encode("pong"));
		expect(decode(await client.read(16))).toBe("pong");
	});

	test("verifies against an IP address host", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0", serverTLS);
		const client = await net.dial("tcp", hostPort(await listener.address()), "", trustTestCA);
		await client.close();
	});

	test("rejects an untrusted certificate unless verification is disabled", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0", serverTLS);
		const address = hostPort(await listener.address());

		await expect(net.dial("tcp", address, "", {})).rejects.toThrow();
		const client = await net.dial("tcp", address, "", { insecureSkipVerify: true });
		await client.close();
	});

	test("only skips the hostname check with skipHostnameVerification", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0", serverTLS);
		const address = hostPort(await listener.address());
		const wrongName = { ...trustTestCA, serverName: "example.invalid" };

		await expect(net.dial("tcp", address, "", wrongName)).rejects.toThrow();
		const client = await net.dial("tcp", address, "", {
			...wrongName,
			skipHostnameVerification: true,
		});
		await client.close();
		await expect(
			net.dial("tcp", address, "", { serverName: "x.invalid", skipHostnameVerification: true }),
		).rejects.toThrow();
	});

	test("accepts TLS 1.2 ciphers by IANA name", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0", {
			...serverTLS,
			cipherSuites: ["TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256"],
			maxVersion: 0x0303,
			disableSessionTickets: true,
		});
		const client = await net.dial("tcp", hostPort(await listener.address()), "", {
			...trustTestCA,
			cipherSuites: ["TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256"],
			minVersion: 0x0303,
			maxVersion: 0x0303,
			disableSessionTickets: true,
		});
		await client.close();
	});

	test("keeps secure defaults when no cipher name is recognised", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0", serverTLS);
		const client = await net.dial("tcp", hostPort(await listener.address()), "", {
			...trustTestCA,
			cipherSuites: ["NOT_A_REAL_CIPHER"],
		});
		await client.close();
	});

	test("times out a handshake the peer never answers", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const dial = net.dial("tcp", hostPort(await listener.address()), "", {
			...trustTestCA,
			handshakeTimeoutMillis: 20,
		});

		await expect(dial).rejects.toThrow(TIMED_OUT);
	});
});

describe("UDP", () => {
	test("binds listeners with an unspecified host", async () => {
		const listener = await newPlatform().listenPacket("udp", ":0");
		expect((await listener.localAddress()).port).toBeGreaterThan(0);
		await listener.close();
	});

	test("resolves, sends, and receives datagrams", async () => {
		const net = newPlatform();
		const receiver = await net.listenPacket("udp", "127.0.0.1:0");
		const sender = await net.dialPacket("udp", hostPort(await receiver.localAddress()), "");
		const resolved = await net.resolvePacketAddr("udp", "localhost:12345");
		expect(resolved.port).toBe(12345);
		expect(await sender.remoteAddress()).toMatchObject(await receiver.localAddress());
		expect(await receiver.remoteAddress()).toBeNull();

		await sender.writeTo(encode("ping"));
		const message = await receiver.readFrom(16);
		expect(decode(message?.data)).toBe("ping");

		await receiver.writeTo(encode("pong"), message!.address);
		expect(decode((await sender.readFrom(16))?.data)).toBe("pong");
	});

	test("a deadline interrupts a blocked read", async () => {
		const receiver = await newPlatform().listenPacket("udp", "127.0.0.1:0");
		const blocked = receiver.readFrom(16);

		receiver.setReadDeadline(Date.now() + 5);

		await expect(blocked).rejects.toThrow(TIMED_OUT);
	});

	test("closing fails a blocked read and repeat closes with the closed error", async () => {
		const receiver = await newPlatform().listenPacket("udp", "127.0.0.1:0");
		const blocked = receiver.readFrom(16);

		await receiver.close();

		await expect(blocked).rejects.toThrow(CLOSED);
		await expect(receiver.readFrom(16)).rejects.toThrow(CLOSED);
		await expect(receiver.close()).rejects.toThrow(CLOSED);
	});

	test("reports a refused port to readers and stays usable", async () => {
		const net = newPlatform();
		const closed = await net.listenPacket("udp", "127.0.0.1:0");
		const address = hostPort(await closed.localAddress());
		await closed.close();
		const client = await net.dialPacket("udp", address, "");
		client.setReadDeadline(Date.now() + 500);

		await client.writeTo(encode("ping"));
		const first = await client.readFrom(16).catch((error: Error) => error);
		expect(first).toBeInstanceOf(Error);

		client.setReadDeadline();
		await client.writeTo(encode("ping")).catch(() => undefined);
		await client.close();
	});

	test("rejects unsupported networks and mismatched address families", async () => {
		const net = newPlatform();
		await expect(net.listenPacket("tcp", ":0")).rejects.toThrow("unsupported packet network");
		await expect(net.resolvePacketAddr("udp6", "127.0.0.1:1")).rejects.toThrow("does not match");
	});

	test("dials IPv6 literals on the udp network", async () => {
		if (!(await canBindIPv6())) return;
		const net = newPlatform();
		const receiver = await net.listenPacket("udp", "[::1]:0");
		const { port } = await receiver.localAddress();
		const sender = await net.dialPacket("udp", `[::1]:${port}`, "");

		await sender.writeTo(encode("ping"));
		expect(decode((await receiver.readFrom(16))?.data)).toBe("ping");
	});

	test("wildcard listeners answer both IPv4 and IPv6 peers", async () => {
		if (!(await canBindIPv6())) return;
		const net = newPlatform();
		const listener = await net.listenPacket("udp", ":0");
		const { port } = await listener.localAddress();
		const v4 = await net.dialPacket("udp", `127.0.0.1:${port}`, "");
		const v6 = await net.dialPacket("udp", `[::1]:${port}`, "");

		await v4.writeTo(encode("four"));
		const fromV4 = await listener.readFrom(16);
		expect(fromV4?.address.address).toBe("127.0.0.1");
		await listener.writeTo(encode("four back"), fromV4!.address);
		expect(decode((await v4.readFrom(16))?.data)).toBe("four back");

		await v6.writeTo(encode("six"));
		const fromV6 = await listener.readFrom(16);
		expect(fromV6?.address.address).toBe("::1");
	});
});

describe("closeAll", () => {
	test("closes every open handle, wakes blocked calls, and frees ports", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const tcpAddress = await listener.address();
		const client = await net.dial("tcp", hostPort(tcpAddress), "");
		const server = await listener.accept();
		const packet = await net.listenPacket("udp", "127.0.0.1:0");
		const udpAddress = await packet.localAddress();

		const blocked = [client.read(16), server.read(16), packet.readFrom(16), listener.accept()];
		await net.closeAll();
		for (const operation of blocked) await expect(operation).rejects.toThrow(CLOSED);

		const next = newPlatform();
		await next.listen("tcp", hostPort(tcpAddress));
		await next.listenPacket("udp", hostPort(udpAddress));
	});

	test("rejects sockets opened after the run ended", async () => {
		const net = newPlatform();
		await net.closeAll();

		await expect(net.listenPacket("udp", "127.0.0.1:0")).rejects.toThrow(CLOSED);
		await expect(net.listen("tcp", "127.0.0.1:0")).rejects.toThrow(CLOSED);
		await expect(net.dial("tcp", "127.0.0.1:1", "")).rejects.toThrow();
	});
});
