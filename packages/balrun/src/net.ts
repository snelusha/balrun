import type { Socket as DatagramSocket } from "node:dgram";
import type { AddressInfo, Server, Socket } from "node:net";
import type { ConnectionOptions, TlsOptions } from "node:tls";

const NODE_NET_MODULE = "node:net";
const NODE_TLS_MODULE = "node:tls";
const NODE_DGRAM_MODULE = "node:dgram";
const NODE_DNS_MODULE = "node:dns/promises";
const NODE_CRYPTO_MODULE = "node:crypto";

// net_wasm.go maps these error codes back to the errors Go callers check for.
const TIMEOUT_CODE = "BALRUN_NET_TIMEOUT";
const CLOSED_CODE = "BALRUN_NET_CLOSED";

// Matches the idle time and interval of Go's default TCP keep-alive.
const TCP_KEEPALIVE_MILLIS = 15_000;
const MAX_TIMER_DELAY = 2 ** 31 - 1;
const SSL_OP_NO_TICKET = 0x00004000;
// Stops reading from a TCP peer past this much unread data, so backpressure reaches the sender.
const STREAM_HIGH_WATER_BYTES = 1024 * 1024;
const STREAM_LOW_WATER_BYTES = STREAM_HIGH_WATER_BYTES / 2;
// Like a kernel receive buffer, datagrams past this limit are dropped.
const MAX_QUEUED_DATAGRAM_BYTES = 4 * 1024 * 1024;
const DATAGRAM_OVERHEAD_BYTES = 64;
// Like a full kernel accept backlog, connections past this limit are refused.
const MAX_PENDING_CONNECTIONS = 1024;
const IPV4_MAPPED_PREFIX = "::ffff:";

// Go's cipher list never affects TLSv1.3, but Node turns TLSv1.3 off unless the list names a suite.
const TLS13_CIPHERS = [
	"TLS_AES_128_GCM_SHA256",
	"TLS_AES_256_GCM_SHA384",
	"TLS_CHACHA20_POLY1305_SHA256",
];

// Node reads every `TLS_*` name as a TLSv1.3 suite, so TLSv1.2 IANA names need their OpenSSL names.
const OPENSSL_CIPHERS: Record<string, string> = {
	TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256: "ECDHE-ECDSA-AES128-GCM-SHA256",
	TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256: "ECDHE-RSA-AES128-GCM-SHA256",
	TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384: "ECDHE-ECDSA-AES256-GCM-SHA384",
	TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384: "ECDHE-RSA-AES256-GCM-SHA384",
	TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256: "ECDHE-ECDSA-CHACHA20-POLY1305",
	TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256: "ECDHE-RSA-CHACHA20-POLY1305",
	TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA: "ECDHE-ECDSA-AES128-SHA",
	TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA: "ECDHE-RSA-AES128-SHA",
	TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA: "ECDHE-ECDSA-AES256-SHA",
	TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA: "ECDHE-RSA-AES256-SHA",
	TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256: "ECDHE-ECDSA-AES128-SHA256",
	TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256: "ECDHE-RSA-AES128-SHA256",
	TLS_RSA_WITH_AES_128_GCM_SHA256: "AES128-GCM-SHA256",
	TLS_RSA_WITH_AES_256_GCM_SHA384: "AES256-GCM-SHA384",
	TLS_RSA_WITH_AES_128_CBC_SHA: "AES128-SHA",
	TLS_RSA_WITH_AES_256_CBC_SHA: "AES256-SHA",
	TLS_RSA_WITH_AES_128_CBC_SHA256: "AES128-SHA256",
	TLS_ECDHE_RSA_WITH_3DES_EDE_CBC_SHA: "ECDHE-RSA-DES-CBC3-SHA",
	TLS_RSA_WITH_3DES_EDE_CBC_SHA: "DES-CBC3-SHA",
};

export interface SocketAddress {
	address: string;
	port: number;
	family?: string;
}

export interface TLSOptions {
	ca?: Uint8Array;
	cert?: Uint8Array;
	key?: Uint8Array;
	serverName?: string;
	minVersion?: number;
	maxVersion?: number;
	cipherSuites?: string[];
	handshakeTimeoutMillis?: number;
	disableSessionTickets?: boolean;
	insecureSkipVerify?: boolean;
	skipHostnameVerification?: boolean;
}

export interface NetPlatform {
	dial(
		network: string,
		address: string,
		localAddress: string,
		tls?: TLSOptions,
		signal?: AbortSignal,
	): Promise<StreamHandle>;
	listen(network: string, address: string, tls?: TLSOptions): Promise<ListenerHandle>;
	dialPacket(
		network: string,
		address: string,
		localAddress: string,
		signal?: AbortSignal,
	): Promise<PacketHandle>;
	listenPacket(network: string, address: string): Promise<PacketHandle>;
	resolvePacketAddr(network: string, address: string): Promise<SocketAddress>;
	/** Closes every handle still open and rejects any later use of this platform. */
	closeAll(): Promise<void>;
}

export interface StreamHandle {
	read(size: number): Promise<Uint8Array | null>;
	write(data: Uint8Array): Promise<number>;
	close(): Promise<void>;
	localAddress(): SocketAddress;
	remoteAddress(): SocketAddress;
	/** Applies to in-flight operations too; `undefined` clears it. Returns false once closed. */
	setReadDeadline(unixMillis?: number): boolean;
	setWriteDeadline(unixMillis?: number): boolean;
}

export interface ListenerHandle {
	accept(): Promise<StreamHandle>;
	close(): Promise<void>;
	address(): SocketAddress;
}

export interface PacketHandle {
	readFrom(size: number): Promise<{ data: Uint8Array; address: SocketAddress }>;
	writeTo(data: Uint8Array, address?: SocketAddress): Promise<number>;
	close(): Promise<void>;
	localAddress(): SocketAddress;
	remoteAddress(): SocketAddress | null;
	/** Applies to in-flight operations too; `undefined` clears it. Returns false once closed. */
	setReadDeadline(unixMillis?: number): boolean;
	setWriteDeadline(unixMillis?: number): boolean;
}

export function createNetPlatform(): NetPlatform {
	return new NodeNetPlatform();
}

interface Closable {
	close(): Promise<void>;
}

class HandleTracker {
	private handles = new Set<Closable>();
	private shutdown = new AbortController();

	get closed(): boolean {
		return this.shutdown.signal.aborted;
	}

	signal(signal: AbortSignal | undefined): AbortSignal {
		return signal ? AbortSignal.any([this.shutdown.signal, signal]) : this.shutdown.signal;
	}

	add(handle: Closable): void {
		this.handles.add(handle);
	}

	delete(handle: Closable): void {
		this.handles.delete(handle);
	}

	/** Registers a newly opened handle, closing it if the run ended while it was opening. */
	async adopt<T extends Closable>(handle: T): Promise<T> {
		if (this.closed) {
			await handle.close().catch(() => undefined);
			throw closedError();
		}
		this.add(handle);
		return handle;
	}

	async closeAll(): Promise<void> {
		this.shutdown.abort();
		const handles = [...this.handles];
		this.handles.clear();
		await Promise.allSettled(handles.map((handle) => handle.close()));
	}
}

class NodeNetPlatform implements NetPlatform {
	private tracker = new HandleTracker();

	async dial(
		network: string,
		address: string,
		localAddress: string,
		tls?: TLSOptions,
		signal?: AbortSignal,
	): Promise<StreamHandle> {
		const family = tcpFamily(network);
		const remote = parseAddress(address);
		// Like Go, an empty host means the local system.
		const host = remote.address || "localhost";
		await assertLiteralFamily(host, family);
		const combined = this.tracker.signal(signal);
		const local = await abortable(resolveLocal(family, localAddress), combined);
		const target = { host, port: remote.port, family, local, signal: combined };
		const socket = tls ? await connectTLS(target, tls) : await connectTCP(target);
		return this.tracker.adopt(new NodeStream(socket, this.tracker));
	}

	async listen(network: string, address: string, tls?: TLSOptions): Promise<ListenerHandle> {
		const family = tcpFamily(network);
		const local = parseAddress(address);
		const server = tls
			? await createTLSServer(tls)
			: (await nodeNet()).createServer({ allowHalfOpen: true });
		await listen(server, await listenHost(family, local), local.port, family === 6);
		const listener = new NodeListener(server, this.tracker);
		server.on(tls ? "secureConnection" : "connection", (socket: Socket) => listener.push(socket));
		return this.tracker.adopt(listener);
	}

	async dialPacket(
		network: string,
		address: string,
		localAddress: string,
		signal?: AbortSignal,
	): Promise<PacketHandle> {
		const networkFamily = udpFamily(network);
		const target = parseAddress(address);
		const combined = this.tracker.signal(signal);
		const local = await abortable(resolveLocal(networkFamily, localAddress), combined);
		// Like Go, a specific local address limits which remote addresses can be used.
		const family = local?.address ? familyNumber(local.family) : networkFamily;
		const remote = await abortable(
			resolveAddress(family, { ...target, address: target.address || "localhost" }, false),
			combined,
		);
		const socket = (await nodeDgram()).createSocket({
			type: remote.family === "IPv6" ? "udp6" : "udp4",
			ipv6Only: networkFamily === 6,
		});
		try {
			if (local) await abortable(bind(socket, local.address || undefined, local.port), combined);
			await abortable(connectDatagram(socket, remote.address, remote.port), combined);
		} catch (error) {
			closeQuietly(socket);
			throw error;
		}
		return this.tracker.adopt(new NodePacket(socket, this.tracker, { remote }));
	}

	async listenPacket(network: string, address: string): Promise<PacketHandle> {
		const family = udpFamily(network);
		const local = parseAddress(address);
		return this.tracker.adopt(
			family === 0 && isWildcard(local.address)
				? await this.listenDualStack(local.port)
				: await this.bindPacket(family, local),
		);
	}

	async resolvePacketAddr(network: string, address: string): Promise<SocketAddress> {
		const family = udpFamily(network);
		const target = parseAddress(address);
		// Go leaves an empty host unresolved and sends such datagrams to the local host.
		if (target.address === "") return target;
		return resolveAddress(family, target, true);
	}

	closeAll(): Promise<void> {
		return this.tracker.closeAll();
	}

	private async bindPacket(family: 0 | 4 | 6, local: SocketAddress): Promise<NodePacket> {
		const { createSocket } = await nodeDgram();
		const resolved = local.address === "" ? undefined : await resolveAddress(family, local, true);
		const socket = createSocket({
			type: family === 6 || resolved?.family === "IPv6" ? "udp6" : "udp4",
			ipv6Only: family === 6,
		});
		try {
			await bind(socket, resolved?.address, local.port);
		} catch (error) {
			closeQuietly(socket);
			throw error;
		}
		return new NodePacket(socket, this.tracker);
	}

	// Like Go, an unspecified host on "udp" accepts both IPv4 and IPv6 where the host allows it.
	private async listenDualStack(port: number): Promise<NodePacket> {
		const { createSocket } = await nodeDgram();
		const socket = createSocket({ type: "udp6", ipv6Only: false });
		try {
			await bind(socket, "::", port);
		} catch (error) {
			closeQuietly(socket);
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL") throw error;
			return this.bindPacket(4, { address: "0.0.0.0", port });
		}
		return new NodePacket(socket, this.tracker, { dualStack: true });
	}
}

/** A resettable deadline that rejects every operation waiting on it when it expires. */
class Deadline {
	private at: number | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private expired = false;
	private rejecters = new Set<(error: Error) => void>();

	set(unixMillis?: number): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.at = unixMillis;
		this.expired = false;
		this.arm();
	}

	check(): void {
		if (this.expired) throw timeoutError();
	}

	race<T>(operation: Promise<T>): Promise<T> {
		if (this.expired) return Promise.reject(timeoutError());
		return new Promise<T>((resolve, reject) => {
			this.rejecters.add(reject);
			void operation.then(
				(value) => {
					this.rejecters.delete(reject);
					resolve(value);
				},
				(error: unknown) => {
					this.rejecters.delete(reject);
					reject(error);
				},
			);
		});
	}

	/** Clears the deadline and fails every waiting operation with `error`. */
	cancel(error: Error): void {
		this.set();
		for (const reject of this.rejecters) reject(error);
		this.rejecters.clear();
	}

	private arm(): void {
		if (this.at === undefined) return;
		const delay = this.at - Date.now();
		if (delay <= 0) {
			this.expire();
			return;
		}
		// Longer delays would overflow setTimeout and fire immediately, so re-arm in steps.
		this.timer = setTimeout(() => this.arm(), Math.min(delay, MAX_TIMER_DELAY));
		(this.timer as { unref?: () => void }).unref?.();
	}

	private expire(): void {
		this.expired = true;
		for (const reject of this.rejecters) reject(timeoutError());
		this.rejecters.clear();
	}
}

/** Wakes every waiter at once, so concurrent readers and timed-out reads can't lose a wakeup. */
class Signal {
	private pending: Promise<void> | undefined;
	private resolve: (() => void) | undefined;

	wait(): Promise<void> {
		this.pending ??= new Promise((resolve) => (this.resolve = resolve));
		return this.pending;
	}

	wake(): void {
		this.resolve?.();
		this.pending = undefined;
		this.resolve = undefined;
	}
}

abstract class DeadlineHandle {
	protected closed = false;
	protected readDeadline = new Deadline();
	protected writeDeadline = new Deadline();

	setReadDeadline(unixMillis?: number): boolean {
		if (this.closed) return false;
		this.readDeadline.set(unixMillis);
		return true;
	}

	setWriteDeadline(unixMillis?: number): boolean {
		if (this.closed) return false;
		this.writeDeadline.set(unixMillis);
		return true;
	}

	protected ensureOpen(): void {
		if (this.closed) throw closedError();
	}

	protected markClosed(): void {
		this.ensureOpen();
		this.closed = true;
		this.readDeadline.cancel(closedError());
		this.writeDeadline.cancel(closedError());
	}

	protected async writeWithDeadline(
		size: number,
		send: (done: (error?: Error | null) => void) => void,
	): Promise<number> {
		this.ensureOpen();
		this.writeDeadline.check();
		try {
			await this.writeDeadline.race(
				new Promise<void>((resolve, reject) =>
					send((error) => (error ? reject(error) : resolve())),
				),
			);
		} catch (error) {
			this.ensureOpen();
			if (isTimeout(error)) this.onWriteTimeout();
			throw error;
		}
		return size;
	}

	protected onWriteTimeout(): void {}
}

class NodeStream extends DeadlineHandle implements StreamHandle {
	private chunks: Uint8Array[] = [];
	private bufferedBytes = 0;
	private paused = false;
	private ended = false;
	private failure: Error | null = null;
	private signal = new Signal();
	private local: SocketAddress;
	private remote: SocketAddress;

	constructor(
		private socket: Socket,
		private tracker: HandleTracker,
	) {
		super();
		// Go's TCP connections default to both; without them small writes stall on Nagle's
		// algorithm and a vanished peer is never detected.
		socket.setNoDelay(true);
		socket.setKeepAlive(true, TCP_KEEPALIVE_MILLIS);
		// Addresses are captured now because Go can still ask after the socket has gone away.
		this.local = socketAddress(socket.address());
		this.remote = {
			address: fromIPv4Mapped(socket.remoteAddress ?? ""),
			port: socket.remotePort ?? 0,
			family: socket.remoteFamily,
		};
		socket.on("data", (chunk: Uint8Array) => this.push(chunk));
		socket.once("end", () => this.finish());
		socket.once("close", () => {
			this.finish();
			this.tracker.delete(this);
		});
		socket.on("error", (error: Error) => this.fail(error));
	}

	async read(size: number): Promise<Uint8Array | null> {
		this.ensureOpen();
		this.readDeadline.check();
		while (this.chunks.length === 0 && !this.ended && !this.failure) {
			await this.readDeadline.race(this.signal.wait());
			this.ensureOpen();
		}
		const chunk = this.chunks.shift();
		if (!chunk) {
			if (this.failure) throw this.failure;
			return null;
		}
		const data = chunk.length <= size ? chunk : chunk.subarray(0, size);
		if (data !== chunk) this.chunks.unshift(chunk.subarray(size));
		this.bufferedBytes -= data.length;
		if (this.paused && this.bufferedBytes <= STREAM_LOW_WATER_BYTES) {
			this.paused = false;
			this.socket.resume();
		}
		return data;
	}

	write(data: Uint8Array): Promise<number> {
		return this.writeWithDeadline(data.length, (done) => this.socket.write(data, done));
	}

	async close(): Promise<void> {
		this.markClosed();
		this.tracker.delete(this);
		// A write stuck behind a stalled peer would keep a graceful close from ever finishing.
		if (this.socket.writableLength > 0) this.socket.destroy();
		else this.socket.destroySoon();
		this.signal.wake();
	}

	localAddress(): SocketAddress {
		return this.local;
	}

	remoteAddress(): SocketAddress {
		return this.remote;
	}

	// Node can't take back bytes it has queued, and Go would report them as unsent, so a retry
	// would send them twice. Ending the connection is the only way to keep the stream intact.
	protected override onWriteTimeout(): void {
		this.fail(new Error("connection aborted because a write timed out"));
		this.socket.destroy();
	}

	private push(chunk: Uint8Array): void {
		this.chunks.push(chunk);
		this.bufferedBytes += chunk.length;
		if (!this.paused && this.bufferedBytes > STREAM_HIGH_WATER_BYTES) {
			this.paused = true;
			this.socket.pause();
		}
		this.signal.wake();
	}

	private finish(): void {
		this.ended = true;
		this.signal.wake();
	}

	private fail(error: Error): void {
		this.failure ??= error;
		this.signal.wake();
	}
}

class NodeListener implements ListenerHandle {
	private pending: NodeStream[] = [];
	private waiters: { resolve: (stream: NodeStream) => void; reject: (error: Error) => void }[] = [];
	private closed = false;
	private failure: Error | null = null;
	private local: SocketAddress;

	constructor(
		private server: Server,
		private tracker: HandleTracker,
	) {
		this.local = socketAddress(server.address());
		server.on("error", (error: Error) => this.fail(error));
	}

	push(socket: Socket): void {
		if (
			this.closed ||
			(this.waiters.length === 0 && this.pending.length >= MAX_PENDING_CONNECTIONS)
		) {
			socket.on("error", () => undefined);
			socket.destroy();
			return;
		}
		const stream = new NodeStream(socket, this.tracker);
		this.tracker.add(stream);
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve(stream);
		else this.pending.push(stream);
	}

	async accept(): Promise<StreamHandle> {
		if (this.closed) throw closedError();
		const stream = this.pending.shift();
		if (stream) return stream;
		if (this.failure) {
			// Reported once: the listener stays open, and a retrying caller mustn't spin on it.
			const failure = this.failure;
			this.failure = null;
			throw failure;
		}
		return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
	}

	// Like Go, this stops listening but leaves connections that were already accepted open.
	// Node's close callback waits for those connections, so it can't be awaited here.
	async close(): Promise<void> {
		if (this.closed) throw closedError();
		this.closed = true;
		this.tracker.delete(this);
		this.server.close();
		this.rejectWaiters(closedError());
		const pending = this.pending;
		this.pending = [];
		await Promise.allSettled(pending.map((stream) => stream.close()));
	}

	address(): SocketAddress {
		return this.local;
	}

	private fail(error: Error): void {
		if (this.waiters.length > 0) this.rejectWaiters(error);
		else this.failure = error;
	}

	private rejectWaiters(error: Error): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) waiter.reject(error);
	}
}

class NodePacket extends DeadlineHandle implements PacketHandle {
	private messages: { data: Uint8Array; address: SocketAddress }[] = [];
	private queuedBytes = 0;
	private signal = new Signal();
	private failure: Error | null = null;
	private local: SocketAddress;
	private remote: SocketAddress | undefined;
	private dualStack: boolean;

	constructor(
		private socket: DatagramSocket,
		private tracker: HandleTracker,
		options: { remote?: SocketAddress; dualStack?: boolean } = {},
	) {
		super();
		this.remote = options.remote;
		this.dualStack = options.dualStack ?? false;
		// Captured now because Node throws if asked after the socket has closed.
		this.local = socketAddress(socket.address());
		socket.on("message", (data, info) => {
			const cost = data.length + DATAGRAM_OVERHEAD_BYTES;
			if (this.queuedBytes + cost > MAX_QUEUED_DATAGRAM_BYTES) return;
			this.queuedBytes += cost;
			this.messages.push({
				data,
				address: { address: fromIPv4Mapped(info.address), port: info.port, family: info.family },
			});
			this.signal.wake();
		});
		socket.on("error", (error: Error) => {
			this.failure = error;
			this.signal.wake();
		});
		socket.once("close", () => {
			this.tracker.delete(this);
			this.signal.wake();
		});
	}

	async readFrom(size: number): Promise<{ data: Uint8Array; address: SocketAddress }> {
		this.ensureOpen();
		this.readDeadline.check();
		while (this.messages.length === 0 && !this.failure) {
			await this.readDeadline.race(this.signal.wait());
			this.ensureOpen();
		}
		const message = this.messages.shift();
		if (!message) {
			// Datagram errors such as ECONNREFUSED are transient: report once, keep the socket usable.
			const failure = this.failure as Error;
			this.failure = null;
			throw failure;
		}
		this.queuedBytes -= message.data.length + DATAGRAM_OVERHEAD_BYTES;
		return { ...message, data: message.data.subarray(0, size) };
	}

	writeTo(data: Uint8Array, address?: SocketAddress): Promise<number> {
		return this.writeWithDeadline(data.length, (done) => {
			if (address) {
				const host = this.dualStack ? toIPv4Mapped(address.address) : address.address;
				this.socket.send(data, address.port, host, done);
			} else if (this.remote) this.socket.send(data, done);
			else done(new Error("packet destination is required"));
		});
	}

	async close(): Promise<void> {
		this.markClosed();
		this.tracker.delete(this);
		this.signal.wake();
		await new Promise<void>((resolve) => this.socket.close(() => resolve()));
	}

	localAddress(): SocketAddress {
		return this.local;
	}

	remoteAddress(): SocketAddress | null {
		return this.remote ?? null;
	}
}

async function nodeNet(): Promise<typeof import("node:net")> {
	return import(/* @vite-ignore */ NODE_NET_MODULE);
}
async function nodeTLS(): Promise<typeof import("node:tls")> {
	return import(/* @vite-ignore */ NODE_TLS_MODULE);
}
async function nodeDgram(): Promise<typeof import("node:dgram")> {
	return import(/* @vite-ignore */ NODE_DGRAM_MODULE);
}
async function nodeDNS(): Promise<typeof import("node:dns/promises")> {
	return import(/* @vite-ignore */ NODE_DNS_MODULE);
}
async function nodeCrypto(): Promise<typeof import("node:crypto")> {
	return import(/* @vite-ignore */ NODE_CRYPTO_MODULE);
}

interface DialTarget {
	host: string;
	port: number;
	family: 0 | 4 | 6;
	local: SocketAddress | undefined;
	signal: AbortSignal;
}

function socketOptions({ host, port, family, local }: DialTarget) {
	return {
		host,
		port,
		// Go can keep writing after the peer's FIN; Node would otherwise end the socket for us.
		allowHalfOpen: true,
		...(family !== 0 && { family }),
		...(local?.address && { localAddress: local.address }),
		...(local && { localPort: local.port }),
	};
}

async function connectTCP(target: DialTarget): Promise<Socket> {
	target.signal.throwIfAborted();
	const socket = (await nodeNet()).connect(socketOptions(target));
	await waitForConnection(socket, "connect", target.signal);
	return socket;
}

async function connectTLS(target: DialTarget, options: TLSOptions): Promise<Socket> {
	target.signal.throwIfAborted();
	const [tls, net] = await Promise.all([nodeTLS(), nodeNet()]);
	await assertValidCA(options.ca);
	const serverName = options.serverName || target.host;
	const connection: ConnectionOptions = {
		...socketOptions(target),
		rejectUnauthorized: !options.insecureSkipVerify,
		// RFC 6066 forbids IP addresses in SNI, and Node warns if given one.
		...(net.isIP(serverName) === 0 && { servername: serverName }),
		// Node would check the dial host whenever SNI is omitted, not the configured server name.
		checkServerIdentity: options.skipHostnameVerification
			? () => undefined
			: (_host, certificate) => tls.checkServerIdentity(serverName, certificate),
		...tlsContextOptions(options),
		...systemTrust(tls, options),
	};
	const socket = tls.connect(connection);
	await waitForConnection(socket, "secureConnect", target.signal, options.handshakeTimeoutMillis);
	return socket;
}

async function createTLSServer(options: TLSOptions): Promise<Server> {
	if (!options.cert?.length || !options.key?.length) {
		throw new Error("TLS listener requires a certificate and private key");
	}
	await assertValidCA(options.ca);
	const verifyClient = !!options.ca?.length;
	return (await nodeTLS()).createServer({
		allowHalfOpen: true,
		...tlsContextOptions(options),
		requestCert: verifyClient,
		rejectUnauthorized: verifyClient,
	});
}

function tlsContextOptions(
	options: TLSOptions,
): Pick<
	TlsOptions,
	"ca" | "cert" | "key" | "ciphers" | "minVersion" | "maxVersion" | "secureOptions"
> {
	const { cert, key } = options;
	const ciphers = toOpenSSLCiphers(options.cipherSuites);
	const ca = toBuffer(options.ca);
	const minVersion = tlsVersion(options.minVersion);
	const maxVersion = tlsVersion(options.maxVersion);
	return {
		...(ca && { ca }),
		...(cert?.length && key?.length && { cert: toBuffer(cert), key: toBuffer(key) }),
		...(ciphers && { ciphers }),
		...(minVersion && { minVersion }),
		...(maxVersion && { maxVersion }),
		...(options.disableSessionTickets && { secureOptions: SSL_OP_NO_TICKET }),
	};
}

// The native platform trusts the OS store, while Node defaults to its bundled roots.
function systemTrust(tls: typeof import("node:tls"), options: TLSOptions): { ca?: string[] } {
	if (options.ca?.length || options.insecureSkipVerify) return {};
	const { getCACertificates } = tls as { getCACertificates?: (type: string) => string[] };
	const system = getCACertificates?.("system") ?? [];
	return system.length > 0 ? { ca: system } : {};
}

// Node would otherwise accept a malformed CA and only fail later, as a verification error.
async function assertValidCA(ca: Uint8Array | undefined): Promise<void> {
	if (!ca?.length) return;
	const { X509Certificate } = await nodeCrypto();
	try {
		new X509Certificate(ca);
	} catch {
		throw new Error("failed to parse CA certificate PEM: no valid certificates found");
	}
}

/** Settles once `event` fires; on failure or abort the socket is destroyed and this rejects. */
function waitForConnection(
	socket: Socket,
	event: string,
	signal: AbortSignal,
	handshakeTimeoutMillis?: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			clearTimeout(handshakeTimer);
			socket.off(event, onConnected);
			socket.off("connect", startHandshakeTimer);
			socket.off("error", onError);
			socket.off("close", onClose);
			signal.removeEventListener("abort", onAbort);
		};
		const onConnected = () => {
			cleanup();
			resolve();
		};
		const onError = (error: Error) => {
			cleanup();
			socket.destroy();
			reject(error);
		};
		const onClose = () => onError(new Error("connection closed before it was established"));
		const onAbort = () => onError(cancelledError());
		const startHandshakeTimer = () => {
			if (!handshakeTimeoutMillis) return;
			handshakeTimer = setTimeout(() => onError(timeoutError()), handshakeTimeoutMillis);
		};

		// Keeps an error raised before the caller attaches its own listener from going unhandled.
		socket.on("error", () => undefined);
		socket.once(event, onConnected);
		socket.once("connect", startHandshakeTimer);
		socket.once("error", onError);
		socket.once("close", onClose);
		// An abort while the socket was being set up would never reach the listener below.
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** Rejects as soon as `signal` aborts, for steps that have no way of being cancelled. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(cancelledError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(cancelledError());
		signal.addEventListener("abort", onAbort, { once: true });
		void operation
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function listen(
	server: Server,
	host: string | undefined,
	port: number,
	ipv6Only: boolean,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		server.once("listening", onListening);
		server.once("error", onError);
		server.listen({ host, port, ipv6Only });
	});
}

function bind(socket: DatagramSocket, address: string | undefined, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const onListening = () => {
			socket.off("error", onError);
			resolve();
		};
		const onError = (error: Error) => {
			socket.off("listening", onListening);
			reject(error);
		};
		socket.once("listening", onListening);
		socket.once("error", onError);
		socket.bind(port, address);
	});
}

function connectDatagram(socket: DatagramSocket, address: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		socket.once("error", onError);
		// Node reports most connect failures through this callback rather than an "error" event.
		socket.connect(port, address, (error?: Error | null) => {
			socket.off("error", onError);
			if (error) reject(error);
			else resolve();
		});
	});
}

function closeQuietly(socket: DatagramSocket): void {
	try {
		socket.on("error", () => undefined);
		socket.close();
	} catch {
		// Already closed.
	}
}

/**
 * Resolves a host to one IP. Like Go, binding and ResolvePacketAddr prefer IPv4 when either
 * family is allowed, while dialing keeps the resolver's order.
 */
async function resolveAddress(
	family: 0 | 4 | 6,
	target: SocketAddress,
	preferIPv4: boolean,
): Promise<SocketAddress> {
	const literal = await assertLiteralFamily(target.address, family);
	if (literal !== 0) {
		return { address: target.address, port: target.port, family: `IPv${literal}` };
	}
	const resolved = await (await nodeDNS()).lookup(target.address, { family, all: true });
	const best = (preferIPv4 && resolved.find((entry) => entry.family === 4)) || resolved[0];
	if (!best) throw new Error(`no addresses found for host: ${target.address}`);
	return { address: best.address, port: target.port, family: `IPv${best.family}` };
}

async function assertLiteralFamily(host: string, family: 0 | 4 | 6): Promise<number> {
	const literal = (await nodeNet()).isIP(host);
	if (literal !== 0 && family !== 0 && family !== literal) {
		throw new Error(`address ${host} does not match network family IPv${family}`);
	}
	return literal;
}

/** A wildcard local host stays empty: it shouldn't limit which remote family can be dialed. */
async function resolveLocal(
	family: 0 | 4 | 6,
	localAddress: string,
): Promise<SocketAddress | undefined> {
	if (localAddress === "") return undefined;
	const local = parseAddress(localAddress);
	if (isWildcard(local.address)) return { address: "", port: local.port };
	return resolveAddress(family, local, true);
}

async function listenHost(family: 0 | 4 | 6, local: SocketAddress): Promise<string | undefined> {
	if (local.address !== "") await assertLiteralFamily(local.address, family);
	if (isWildcard(local.address)) {
		// Node's default host is dual-stack, which is what Go does for "tcp".
		return family === 4 ? "0.0.0.0" : family === 6 ? "::" : undefined;
	}
	return (await resolveAddress(family, local, true)).address;
}

function familyNumber(family: string | undefined): 0 | 4 | 6 {
	return family === "IPv4" ? 4 : family === "IPv6" ? 6 : 0;
}

// Named services such as "host:ldap" aren't supported, since Node has no API to look them up.
function parseAddress(value: string): SocketAddress {
	const match = value.match(/^\[([^\]]+)]:(\d*)$/) ?? value.match(/^([^:]*):(\d*)$/);
	if (!match) throw new Error(`invalid socket address: ${value}`);
	return { address: match[1] ?? "", port: Number(match[2] ?? 0) };
}

function socketAddress(address: string | AddressInfo | object | null): SocketAddress {
	const info = (address ?? {}) as Partial<AddressInfo>;
	return { address: fromIPv4Mapped(info.address ?? ""), port: info.port ?? 0, family: info.family };
}

function isWildcard(host: string): boolean {
	return host === "" || host === "0.0.0.0" || host === "::";
}

function fromIPv4Mapped(address: string): string {
	return address.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)
		? address.slice(IPV4_MAPPED_PREFIX.length)
		: address;
}

function toIPv4Mapped(address: string): string {
	return /^\d+\.\d+\.\d+\.\d+$/.test(address) ? IPV4_MAPPED_PREFIX + address : address;
}

function netError(message: string, code: string): Error {
	return Object.assign(new Error(message), { code });
}

function timeoutError(): Error {
	return netError("[balrun]: network operation timed out", TIMEOUT_CODE);
}

function closedError(): Error {
	return netError("[balrun]: use of closed network connection", CLOSED_CODE);
}

function cancelledError(): Error {
	return new Error("[balrun]: network dial cancelled");
}

function isTimeout(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === TIMEOUT_CODE;
}

function toBuffer(value: Uint8Array | undefined): Buffer | undefined {
	return value?.length ? Buffer.from(value) : undefined;
}

function toOpenSSLCiphers(names: string[] | undefined): string | undefined {
	if (!names?.length) return undefined;
	const known = names.filter((name) => TLS13_CIPHERS.includes(name) || OPENSSL_CIPHERS[name]);
	if (known.length === 0) {
		console.warn(`warning: no valid cipher suites in ${names.join(", ")}; keeping secure defaults`);
		return undefined;
	}
	const resolved = known.flatMap((name) => OPENSSL_CIPHERS[name] ?? []);
	return [...resolved, ...TLS13_CIPHERS].join(":");
}

function tlsVersion(
	value: number | undefined,
): "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3" | undefined {
	if (value === 0x0301) return "TLSv1";
	if (value === 0x0302) return "TLSv1.1";
	if (value === 0x0303) return "TLSv1.2";
	if (value === 0x0304) return "TLSv1.3";
	return undefined;
}

function tcpFamily(network: string): 0 | 4 | 6 {
	if (network === "tcp") return 0;
	if (network === "tcp4") return 4;
	if (network === "tcp6") return 6;
	throw new Error(`unsupported stream network: ${network}`);
}

function udpFamily(network: string): 0 | 4 | 6 {
	if (network === "udp") return 0;
	if (network === "udp4") return 4;
	if (network === "udp6") return 6;
	throw new Error(`unsupported packet network: ${network}`);
}
