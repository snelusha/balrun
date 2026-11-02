import { createSocket } from "node:dgram";
import type { Socket as DatagramSocket } from "node:dgram";
import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
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

const hasIPv6 = await new Promise<boolean>((resolve) => {
	const socket = createSocket("udp6");
	socket.once("error", () => resolve(false));
	socket.bind(0, "::1", () => socket.close(() => resolve(true)));
});

describe("TCP", () => {
	test("connects accepted streams and transfers bytes", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const client = await net.dial("tcp", hostPort(listener.address()), "");
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
		const client = await net.dial("tcp", hostPort(listener.address()), "");
		const server = await listener.accept();

		await client.write(encode("abcdef"));
		expect(decode(await server.read(4))).toBe("abcd");
		expect(decode(await server.read(4))).toBe("ef");
	});

	test("closing a listener leaves accepted connections open and rejects a blocked accept", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const client = await net.dial("tcp", hostPort(listener.address()), "");
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
		const client = await net.dial("tcp", hostPort(listener.address()), "");
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
		const client = await net.dial("tcp", hostPort(listener.address()), "");
		const blocked = client.read(16);

		client.setReadDeadline(Date.now() + 5);

		await expect(blocked).rejects.toThrow(TIMED_OUT);
		await expect(client.read(16)).rejects.toThrow(TIMED_OUT);
	});

	test("clearing a deadline makes the handle usable again", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const client = await net.dial("tcp", hostPort(listener.address()), "");
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
		const client = await net.dial("tcp", hostPort(listener.address()), "");
		const server = await listener.accept();

		client.setReadDeadline(Date.now() + 2 ** 33);
		await Bun.sleep(5);
		await server.write(encode("pong"));
		expect(decode(await client.read(16))).toBe("pong");
	});

	test("an expired write deadline fails writes", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const client = await net.dial("tcp", hostPort(listener.address()), "");

		client.setWriteDeadline(Date.now() - 1);
		await expect(client.write(encode("x"))).rejects.toThrow(TIMED_OUT);
	});

	test("rejects dials that are refused or already aborted", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const address = hostPort(listener.address());
		await listener.close();
		await Bun.sleep(50);

		await expect(net.dial("tcp", address, "")).rejects.toThrow();
		await expect(net.dial("tcp", address, "", undefined, AbortSignal.abort())).rejects.toThrow();
	});

	test("aborting stops a dial that is waiting on the handshake", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const controller = new AbortController();
		const dial = net.dial("tcp", hostPort(listener.address()), "", trustTestCA, controller.signal);

		await Bun.sleep(5);
		controller.abort();

		await expect(dial).rejects.toThrow("network dial cancelled");
	});
});

describe("TCP semantics", () => {
	test("can still write after the peer half-closes", async () => {
		const net = newPlatform();
		const server = createServer({ allowHalfOpen: true }, (socket) => {
			socket.on("error", () => undefined);
			socket.resume();
			socket.end("request");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		const received = new Promise<string>((resolve) => {
			server.once("connection", (socket) => {
				let text = "";
				socket.on("data", (chunk) => (text += chunk));
				socket.on("end", () => resolve(text));
			});
		});
		const client = await net.dial("tcp", `127.0.0.1:${port}`, "");

		expect(decode(await client.read(16))).toBe("request");
		expect(await client.read(16)).toBeNull();
		await Bun.sleep(20);
		await client.write(encode("response"));
		await client.close();

		expect(await received).toBe("response");
		server.close();
	});

	test("applies backpressure, and a timed-out write ends the connection", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const client = await net.dial("tcp", hostPort(listener.address()), "");
		const server = await listener.accept();
		const chunk = new Uint8Array(1024 * 1024);

		server.setWriteDeadline(Date.now() + 300);
		let sent = 0;
		let failure: unknown;
		while (!failure && sent < 256) {
			await server.write(chunk).then(
				() => sent++,
				(error: unknown) => (failure = error),
			);
		}
		expect(failure).toMatchObject({ code: "BALRUN_NET_TIMEOUT" });

		server.setWriteDeadline();
		await expect(server.write(encode("retry"))).rejects.not.toMatchObject({
			code: "BALRUN_NET_TIMEOUT",
		});
		await client.close();
	});

	test("reads split across many small buffers keep their order past the high-water mark", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const client = await net.dial("tcp", hostPort(listener.address()), "");
		const server = await listener.accept();
		const payload = Uint8Array.from({ length: 3 * 1024 * 1024 }, (_, i) => i % 251);

		const writing = client.write(payload).then(() => client.close());
		await Bun.sleep(50);
		const received = new Uint8Array(payload.length);
		let offset = 0;
		while (true) {
			const data = await server.read(32 * 1024);
			if (!data) break;
			received.set(data, offset);
			offset += data.length;
		}
		await writing;

		expect(offset).toBe(payload.length);
		expect(Buffer.compare(received, payload)).toBe(0);
	});

	test("enforces the network family on literal addresses", async () => {
		const net = newPlatform();
		await expect(net.listen("tcp4", "[::1]:0")).rejects.toThrow("does not match");
		await expect(net.dial("tcp4", "[::1]:1", "")).rejects.toThrow("does not match");
		await expect(net.dial("tcp6", "127.0.0.1:1", "")).rejects.toThrow("does not match");
	});

	test("resolves a local hostname, and accepts an empty port", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp4", "127.0.0.1:");
		const client = await net.dial("tcp4", hostPort(listener.address()), "localhost:0");
		expect(client.localAddress().address).toBe("127.0.0.1");
	});

	test("keeps addresses and reports closed deadlines after close", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const client = await net.dial("tcp", hostPort(listener.address()), "");
		const remote = client.remoteAddress();
		await client.close();
		expect(client.remoteAddress()).toEqual(remote);
		expect(client.setReadDeadline(Date.now() + 1000)).toBe(false);
	});

	test("reports a listener failure once rather than on every accept", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const server = (listener as unknown as { server: Server }).server;
		server.emit("error", new Error("boom"));

		await expect(listener.accept()).rejects.toThrow("boom");
		const next = listener.accept();
		const client = await net.dial("tcp", hostPort(listener.address()), "");
		await next;
		await client.close();
	});

	test("refuses connections past the pending limit", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const address = hostPort(listener.address());
		const push = listener as unknown as { pending: unknown[] };
		push.pending = Array.from({ length: 1024 }, () => ({ close: async () => undefined }));
		const client = await net.dial("tcp", address, "");
		expect(await client.read(16).catch(() => null)).toBeNull();
		push.pending = [];
	});
});

describe("TLS", () => {
	test("completes a round trip against a trusted CA", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0", serverTLS);
		const { port } = listener.address();
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
		const client = await net.dial("tcp", hostPort(listener.address()), "", trustTestCA);
		await client.close();
	});

	test("rejects an untrusted certificate unless verification is disabled", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0", serverTLS);
		const address = hostPort(listener.address());

		await expect(net.dial("tcp", address, "", {})).rejects.toThrow();
		const client = await net.dial("tcp", address, "", { insecureSkipVerify: true });
		await client.close();
	});

	test("only skips the hostname check with skipHostnameVerification", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0", serverTLS);
		const address = hostPort(listener.address());
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
		const client = await net.dial("tcp", hostPort(listener.address()), "", {
			...trustTestCA,
			cipherSuites: ["TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256"],
			minVersion: 0x0303,
			maxVersion: 0x0303,
			disableSessionTickets: true,
		});
		await client.close();
	});

	test("keeps TLS 1.3 available when only TLS 1.2 ciphers are configured", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0", serverTLS);
		const client = await net.dial("tcp", hostPort(listener.address()), "", {
			...trustTestCA,
			cipherSuites: ["TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256"],
			minVersion: 0x0304,
		});
		await client.close();
	});

	test("verifies against a configured IP server name, not the dial host", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0", serverTLS);
		const { port } = listener.address();

		await expect(
			net.dial("tcp", `localhost:${port}`, "", { ...trustTestCA, serverName: "10.0.0.5" }),
		).rejects.toThrow();
		const client = await net.dial("tcp", `localhost:${port}`, "", {
			...trustTestCA,
			serverName: "127.0.0.1",
		});
		await client.close();
	});

	test("fails fast on missing or malformed TLS material", async () => {
		const net = newPlatform();
		await expect(net.listen("tcp", "127.0.0.1:0", {})).rejects.toThrow("requires a certificate");
		const garbage = encode("not a certificate");
		await expect(net.listen("tcp", "127.0.0.1:0", { ...serverTLS, ca: garbage })).rejects.toThrow(
			"failed to parse CA",
		);
		const listener = await net.listen("tcp", "127.0.0.1:0", serverTLS);
		await expect(
			net.dial("tcp", hostPort(listener.address()), "", { ca: garbage }),
		).rejects.toThrow("failed to parse CA");
	});

	test("keeps secure defaults when no cipher name is recognised", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0", serverTLS);
		const client = await net.dial("tcp", hostPort(listener.address()), "", {
			...trustTestCA,
			cipherSuites: ["NOT_A_REAL_CIPHER"],
		});
		await client.close();
	});

	test("times out a handshake the peer never answers", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const dial = net.dial("tcp", hostPort(listener.address()), "", {
			...trustTestCA,
			handshakeTimeoutMillis: 20,
		});

		await expect(dial).rejects.toThrow(TIMED_OUT);
	});
});

describe("UDP", () => {
	test("binds listeners with an unspecified host", async () => {
		const listener = await newPlatform().listenPacket("udp", ":0");
		expect(listener.localAddress().port).toBeGreaterThan(0);
		await listener.close();
	});

	test("resolves, sends, and receives datagrams", async () => {
		const net = newPlatform();
		const receiver = await net.listenPacket("udp", "127.0.0.1:0");
		const sender = await net.dialPacket("udp", hostPort(receiver.localAddress()), "");
		const resolved = await net.resolvePacketAddr("udp", "localhost:12345");
		expect(resolved.port).toBe(12345);
		expect(sender.remoteAddress()).toMatchObject(receiver.localAddress());
		expect(receiver.remoteAddress()).toBeNull();

		await sender.writeTo(encode("ping"));
		const message = await receiver.readFrom(16);
		expect(decode(message.data)).toBe("ping");

		await receiver.writeTo(encode("pong"), message.address);
		expect(decode((await sender.readFrom(16)).data)).toBe("pong");
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

	test("reports a refused port once to readers and stays usable", async () => {
		const net = newPlatform();
		const closed = await net.listenPacket("udp", "127.0.0.1:0");
		const address = hostPort(closed.localAddress());
		await closed.close();
		const client = await net.dialPacket("udp", address, "");

		client.setReadDeadline(Date.now() + 2000);
		await client.writeTo(encode("ping"));
		await expect(client.readFrom(16)).rejects.toMatchObject({ code: "ECONNREFUSED" });

		client.setReadDeadline(Date.now() + 5);
		await expect(client.readFrom(16)).rejects.toThrow(TIMED_OUT);
		await client.close();
	});

	test("rejects a dial whose connect fails", async () => {
		const net = newPlatform();
		await expect(net.dialPacket("udp", "255.255.255.255:1", "")).rejects.toThrow();
	});

	test("dials the local host when the host is empty", async () => {
		const net = newPlatform();
		const receiver = await net.listenPacket("udp", ":0");
		const sender = await net.dialPacket("udp", `:${receiver.localAddress().port}`, "");
		await sender.writeTo(encode("ping"));
		expect(decode((await receiver.readFrom(16)).data)).toBe("ping");
	});

	test("binds a dial to a wildcard local address", async () => {
		const net = newPlatform();
		const receiver = await net.listenPacket("udp", "127.0.0.1:0");
		const sender = await net.dialPacket("udp", hostPort(receiver.localAddress()), "0.0.0.0:0");
		await sender.writeTo(encode("ping"));
		expect(decode((await receiver.readFrom(16)).data)).toBe("ping");
	});

	test("keeps addresses and reports closed deadlines after close", async () => {
		const net = newPlatform();
		const receiver = await net.listenPacket("udp", "127.0.0.1:0");
		const address = receiver.localAddress();
		await receiver.close();
		expect(receiver.localAddress()).toEqual(address);
		expect(receiver.setReadDeadline(Date.now() + 1000)).toBe(false);
	});

	test("drops datagrams past the queue limit, and accepts more once drained", async () => {
		const net = newPlatform();
		const receiver = await net.listenPacket("udp", "127.0.0.1:0");
		const { socket } = receiver as unknown as { socket: DatagramSocket };
		const info = { address: "127.0.0.1", family: "IPv4", port: 1, size: 60_000 };
		const deliver = (count: number) => {
			for (let i = 0; i < count; i++) socket.emit("message", new Uint8Array(60_000), info);
		};
		const drain = async () => {
			let received = 0;
			receiver.setReadDeadline(Date.now() + 20);
			await (async () => {
				while (true) {
					await receiver.readFrom(65_535);
					received++;
				}
			})().catch(() => undefined);
			receiver.setReadDeadline();
			return received;
		};

		deliver(100);
		const first = await drain();
		expect(first).toBeGreaterThan(0);
		expect(first).toBeLessThan(100);

		deliver(100);
		expect(await drain()).toBe(first);
	});

	test("rejects unsupported networks and mismatched address families", async () => {
		const net = newPlatform();
		await expect(net.listenPacket("tcp", ":0")).rejects.toThrow("unsupported packet network");
		await expect(net.resolvePacketAddr("udp6", "127.0.0.1:1")).rejects.toThrow("does not match");
	});

	test.if(hasIPv6)("dials IPv6 literals on the udp network", async () => {
		const net = newPlatform();
		const receiver = await net.listenPacket("udp", "[::1]:0");
		const { port } = receiver.localAddress();
		const sender = await net.dialPacket("udp", `[::1]:${port}`, "");

		await sender.writeTo(encode("ping"));
		expect(decode((await receiver.readFrom(16)).data)).toBe("ping");
	});

	test.if(hasIPv6)("wildcard listeners answer both IPv4 and IPv6 peers", async () => {
		const net = newPlatform();
		const listener = await net.listenPacket("udp", ":0");
		const { port } = listener.localAddress();
		const v4 = await net.dialPacket("udp", `127.0.0.1:${port}`, "");
		const v6 = await net.dialPacket("udp", `[::1]:${port}`, "");

		await v4.writeTo(encode("four"));
		const fromV4 = await listener.readFrom(16);
		expect(fromV4.address.address).toBe("127.0.0.1");
		await listener.writeTo(encode("four back"), fromV4.address);
		expect(decode((await v4.readFrom(16)).data)).toBe("four back");

		await v6.writeTo(encode("six"));
		const fromV6 = await listener.readFrom(16);
		expect(fromV6.address.address).toBe("::1");
	});
});

describe("closeAll", () => {
	test("closes every open handle, wakes blocked calls, and frees ports", async () => {
		const net = newPlatform();
		const listener = await net.listen("tcp", "127.0.0.1:0");
		const tcpAddress = listener.address();
		const client = await net.dial("tcp", hostPort(tcpAddress), "");
		const server = await listener.accept();
		const packet = await net.listenPacket("udp", "127.0.0.1:0");
		const udpAddress = packet.localAddress();

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
