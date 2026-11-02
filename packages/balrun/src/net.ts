import type { Socket as DatagramSocket } from "node:dgram";
import type { AddressInfo, Server, Socket } from "node:net";
import type { ConnectionOptions, TlsOptions } from "node:tls";

const NODE_NET_MODULE = "node:net";
const NODE_TLS_MODULE = "node:tls";
const NODE_DGRAM_MODULE = "node:dgram";
const NODE_DNS_MODULE = "node:dns/promises";

// net_wasm.go matches these messages to return os.ErrDeadlineExceeded and net.ErrClosed.
const TIMEOUT_MESSAGE = "[balrun]: network operation timed out";
const CLOSED_MESSAGE = "[balrun]: use of closed network connection";

const MAX_TIMER_DELAY = 2 ** 31 - 1;
const SSL_OP_NO_TICKET = 0x00004000;
const IPV4_MAPPED_PREFIX = "::ffff:";

// Node reads every `TLS_*` name as a TLSv1.3 suite, so TLSv1.2 IANA names need their OpenSSL names.
const OPENSSL_CIPHERS: Record<string, string> = {
	TLS_AES_128_GCM_SHA256: "TLS_AES_128_GCM_SHA256",
	TLS_AES_256_GCM_SHA384: "TLS_AES_256_GCM_SHA384",
	TLS_CHACHA20_POLY1305_SHA256: "TLS_CHACHA20_POLY1305_SHA256",
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
	localAddress(): Promise<SocketAddress>;
	remoteAddress(): Promise<SocketAddress>;
	/** Applies to in-flight operations too; `undefined` clears the deadline. */
	setReadDeadline(unixMillis?: number): void;
	setWriteDeadline(unixMillis?: number): void;
}

export interface ListenerHandle {
	accept(): Promise<StreamHandle>;
	close(): Promise<void>;
	address(): Promise<SocketAddress>;
}

export interface PacketHandle {
	readFrom(size: number): Promise<{ data: Uint8Array; address: SocketAddress } | null>;
	writeTo(data: Uint8Array, address?: SocketAddress): Promise<number>;
	close(): Promise<void>;
	localAddress(): Promise<SocketAddress>;
	remoteAddress(): Promise<SocketAddress | null>;
	/** Applies to in-flight operations too; `undefined` clears the deadline. */
	setReadDeadline(unixMillis?: number): void;
	setWriteDeadline(unixMillis?: number): void;
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
		const { address: host, port } = parseAddress(address);
		if (host === "") throw new Error(`invalid remote socket address: ${address}`);
		const local = localAddress === "" ? undefined : parseAddress(localAddress);
		const target = { host, port, family, local, signal: this.tracker.signal(signal) };
		const socket = tls ? await connectTLS(target, tls) : await connectTCP(target);
		return this.tracker.adopt(new NodeStream(socket, this.tracker));
	}

	async listen(network: string, address: string, tls?: TLSOptions): Promise<ListenerHandle> {
		const family = tcpFamily(network);
		const { address: host, port } = parseAddress(address);
		const server = tls ? await createTLSServer(tls) : (await nodeNet()).createServer();
		const listener = new NodeListener(server, this.tracker);
		server.on(tls ? "secureConnection" : "connection", (socket: Socket) => listener.push(socket));
		await listen(
			server,
			host || (family === 4 ? "0.0.0.0" : family === 6 ? "::" : undefined),
			port,
		);
		return this.tracker.adopt(listener);
	}

	async dialPacket(
		network: string,
		address: string,
		localAddress: string,
		signal?: AbortSignal,
	): Promise<PacketHandle> {
		const target = parseAddress(address);
		if (target.address === "") throw new Error(`invalid remote socket address: ${address}`);
		const remote = await resolveAddress(udpFamily(network), target);
		const { createSocket } = await nodeDgram();
		const socket = createSocket(remote.family === "IPv6" ? "udp6" : "udp4");
		const packet = new NodePacket(socket, this.tracker, { remote });
		try {
			this.tracker.signal(signal).throwIfAborted();
			if (localAddress !== "") {
				const local = parseAddress(localAddress);
				await bind(socket, local.address || undefined, local.port);
			}
			await connectDatagram(socket, remote.address, remote.port);
		} catch (error) {
			await packet.close().catch(() => undefined);
			throw error;
		}
		return this.tracker.adopt(packet);
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
		const target = parseAddress(address);
		// Go leaves an empty host unresolved and sends such datagrams to the local host.
		if (target.address === "") return target;
		return resolveAddress(udpFamily(network), target);
	}

	closeAll(): Promise<void> {
		return this.tracker.closeAll();
	}

	private async bindPacket(family: 0 | 4 | 6, local: SocketAddress): Promise<NodePacket> {
		const { createSocket } = await nodeDgram();
		const resolved = local.address === "" ? undefined : await resolveAddress(family, local);
		const type = family === 6 || resolved?.family === "IPv6" ? "udp6" : "udp4";
		const socket = createSocket(type);
		const packet = new NodePacket(socket, this.tracker);
		try {
			await bind(socket, resolved?.address, local.port);
		} catch (error) {
			await packet.close().catch(() => undefined);
			throw error;
		}
		return packet;
	}

	// Like Go, an unspecified host on "udp" accepts both IPv4 and IPv6 where the host allows it.
	private async listenDualStack(port: number): Promise<NodePacket> {
		const { createSocket } = await nodeDgram();
		const socket = createSocket({ type: "udp6", ipv6Only: false });
		const packet = new NodePacket(socket, this.tracker, { dualStack: true });
		try {
			await bind(socket, "::", port);
			return packet;
		} catch (error) {
			await packet.close().catch(() => undefined);
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL") throw error;
			return this.bindPacket(4, { address: "0.0.0.0", port });
		}
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

class NodeStream implements StreamHandle {
	private chunks: Uint8Array[] = [];
	private ended = false;
	private closed = false;
	private failure: Error | null = null;
	private signal = new Signal();
	private readDeadline = new Deadline();
	private writeDeadline = new Deadline();

	constructor(
		private socket: Socket,
		private tracker: HandleTracker,
	) {
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
		if (chunk.length <= size) return chunk;
		this.chunks.unshift(chunk.subarray(size));
		return chunk.subarray(0, size);
	}

	async write(data: Uint8Array): Promise<number> {
		this.ensureOpen();
		this.writeDeadline.check();
		try {
			await this.writeDeadline.race(
				new Promise<void>((resolve, reject) => {
					this.socket.write(data, (error) => (error ? reject(error) : resolve()));
				}),
			);
		} catch (error) {
			this.ensureOpen();
			throw error;
		}
		return data.length;
	}

	async close(): Promise<void> {
		this.ensureOpen();
		this.closed = true;
		this.tracker.delete(this);
		this.readDeadline.set();
		this.writeDeadline.set();
		// A write stuck behind a stalled peer would keep a graceful close from ever finishing.
		if (this.socket.writableLength > 0) this.socket.destroy();
		else this.socket.destroySoon();
		this.signal.wake();
	}

	async localAddress(): Promise<SocketAddress> {
		return socketAddress(this.socket.address() as AddressInfo | string | null);
	}

	async remoteAddress(): Promise<SocketAddress> {
		if (!this.socket.remoteAddress || this.socket.remotePort === undefined) {
			throw new Error("socket has no remote address");
		}
		return {
			address: this.socket.remoteAddress,
			port: this.socket.remotePort,
			family: this.socket.remoteFamily,
		};
	}

	setReadDeadline(unixMillis?: number): void {
		this.readDeadline.set(unixMillis);
	}

	setWriteDeadline(unixMillis?: number): void {
		this.writeDeadline.set(unixMillis);
	}

	private ensureOpen(): void {
		if (this.closed) throw closedError();
	}

	private push(chunk: Uint8Array): void {
		this.chunks.push(chunk);
		this.signal.wake();
	}

	private finish(): void {
		this.ended = true;
		this.signal.wake();
	}

	private fail(error: Error): void {
		this.failure = error;
		this.signal.wake();
	}
}

class NodeListener implements ListenerHandle {
	private pending: NodeStream[] = [];
	private waiters: { resolve: (stream: NodeStream) => void; reject: (error: Error) => void }[] = [];
	private closed = false;
	private failure: Error | null = null;

	constructor(
		private server: Server,
		private tracker: HandleTracker,
	) {
		server.on("error", (error: Error) => this.fail(error));
	}

	push(socket: Socket): void {
		if (this.closed) {
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
		if (this.failure) throw this.failure;
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

	async address(): Promise<SocketAddress> {
		return socketAddress(this.server.address() as AddressInfo | string | null);
	}

	private fail(error: Error): void {
		this.failure = error;
		this.rejectWaiters(error);
	}

	private rejectWaiters(error: Error): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) waiter.reject(error);
	}
}

class NodePacket implements PacketHandle {
	private messages: { data: Uint8Array; address: SocketAddress }[] = [];
	private signal = new Signal();
	private closed = false;
	private failure: Error | null = null;
	private readDeadline = new Deadline();
	private writeDeadline = new Deadline();
	private remote: SocketAddress | undefined;
	private dualStack: boolean;

	constructor(
		private socket: DatagramSocket,
		private tracker: HandleTracker,
		options: { remote?: SocketAddress; dualStack?: boolean } = {},
	) {
		this.remote = options.remote;
		this.dualStack = options.dualStack ?? false;
		socket.on("message", (data, info) => {
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

	async readFrom(size: number): Promise<{ data: Uint8Array; address: SocketAddress } | null> {
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
		return { ...message, data: message.data.subarray(0, size) };
	}

	async writeTo(data: Uint8Array, address?: SocketAddress): Promise<number> {
		this.ensureOpen();
		this.writeDeadline.check();
		try {
			await this.writeDeadline.race(
				new Promise<void>((resolve, reject) => {
					const done = (error: Error | null) => (error ? reject(error) : resolve());
					if (address) {
						const host = this.dualStack ? toIPv4Mapped(address.address) : address.address;
						this.socket.send(data, address.port, host, done);
					} else if (this.remote) this.socket.send(data, done);
					else reject(new Error("packet destination is required"));
				}),
			);
		} catch (error) {
			this.ensureOpen();
			throw error;
		}
		return data.length;
	}

	async close(): Promise<void> {
		this.ensureOpen();
		this.closed = true;
		this.tracker.delete(this);
		this.readDeadline.set();
		this.writeDeadline.set();
		this.signal.wake();
		await new Promise<void>((resolve) => this.socket.close(() => resolve()));
	}

	async localAddress(): Promise<SocketAddress> {
		const address = this.socket.address();
		return { address: address.address, port: address.port, family: address.family };
	}

	async remoteAddress(): Promise<SocketAddress | null> {
		return this.remote ?? null;
	}

	setReadDeadline(unixMillis?: number): void {
		this.readDeadline.set(unixMillis);
	}

	setWriteDeadline(unixMillis?: number): void {
		this.writeDeadline.set(unixMillis);
	}

	private ensureOpen(): void {
		if (this.closed) throw closedError();
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
	const serverName = options.serverName || target.host;
	const connection: ConnectionOptions = {
		...socketOptions(target),
		rejectUnauthorized: !options.insecureSkipVerify,
		// RFC 6066 forbids IP addresses in SNI, and Node warns if given one.
		...(net.isIP(serverName) === 0 && { servername: serverName }),
		...(options.skipHostnameVerification && { checkServerIdentity: () => undefined }),
		...tlsContextOptions(options),
	};
	const socket = tls.connect(connection);
	await waitForConnection(socket, "secureConnect", target.signal, options.handshakeTimeoutMillis);
	return socket;
}

async function createTLSServer(options: TLSOptions): Promise<Server> {
	const verifyClient = !!options.ca?.length;
	return (await nodeTLS()).createServer({
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
		const onAbort = () => onError(new Error("[balrun]: network dial cancelled"));
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
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function listen(server: Server, host: string | undefined, port: number): Promise<void> {
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
		server.listen({ host, port });
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
		socket.connect(port, address, () => {
			socket.off("error", onError);
			resolve();
		});
	});
}

/** Resolves a host to one IP, preferring IPv4 when either family is allowed (as Go does). */
async function resolveAddress(family: 0 | 4 | 6, target: SocketAddress): Promise<SocketAddress> {
	const { isIP } = await nodeNet();
	const literal = isIP(target.address);
	if (literal !== 0) {
		if (family !== 0 && family !== literal) {
			throw new Error(`address ${target.address} does not match network family IPv${family}`);
		}
		return { address: target.address, port: target.port, family: `IPv${literal}` };
	}
	const resolved = await (await nodeDNS()).lookup(target.address, { family, all: true });
	const best = resolved.find((entry) => entry.family === 4) ?? resolved[0];
	if (!best) throw new Error(`no addresses found for host: ${target.address}`);
	return { address: best.address, port: target.port, family: `IPv${best.family}` };
}

function parseAddress(value: string): SocketAddress {
	const match = value.match(/^\[([^\]]+)]:(\d+)$/) ?? value.match(/^([^:]*):(\d+)$/);
	if (!match || match[2] === undefined) throw new Error(`invalid socket address: ${value}`);
	return { address: match[1] ?? "", port: Number(match[2]) };
}

function socketAddress(address: string | AddressInfo | null): SocketAddress {
	if (!address || typeof address === "string") throw new Error("socket has no IP address");
	return { address: address.address, port: address.port, family: address.family };
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

function timeoutError(): Error {
	return new Error(TIMEOUT_MESSAGE);
}

function closedError(): Error {
	return new Error(CLOSED_MESSAGE);
}

function toBuffer(value: Uint8Array | undefined): Buffer | undefined {
	return value?.length ? Buffer.from(value) : undefined;
}

function toOpenSSLCiphers(names: string[] | undefined): string | undefined {
	const resolved = (names ?? []).flatMap((name) => OPENSSL_CIPHERS[name] ?? []);
	// Like the native platform, keep the secure defaults if no configured name is recognised.
	return resolved.length > 0 ? resolved.join(":") : undefined;
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
