const NODE_NET_MODULE = "node:net";
const NODE_DGRAM_MODULE = "node:dgram";
const NODE_DNS_MODULE = "node:dns/promises";
const NODE_TLS_MODULE = "node:tls";

const CLOSED_SOCKET_CODE = "ECLOSED";
const MAX_QUEUED_DATAGRAMS = 1024;

export type NetFamily = 4 | 6;

export interface NetAddress {
	host: string;
	port: number;
}

export interface ConnectOptions extends NetAddress {
	family?: NetFamily;
	localHost?: string;
	localPort?: number;
	signal?: AbortSignal;
}

export interface BindOptions extends NetAddress {
	family?: NetFamily;
}

export interface ConnectDatagramOptions extends NetAddress {
	localHost?: string;
	localPort?: number;
}

export interface StreamSocket {
	local: NetAddress;
	remote: NetAddress;
	read(): Promise<Uint8Array | null>;
	write(data: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

export interface StreamListener {
	local: NetAddress;
	accept(): Promise<StreamSocket>;
	close(): Promise<void>;
}

export interface ReceivedDatagram extends NetAddress {
	data: Uint8Array;
}

export interface DatagramSocket {
	local: NetAddress;
	remote?: NetAddress;
	receive(): Promise<ReceivedDatagram>;
	send(data: Uint8Array, host?: string, port?: number): Promise<void>;
	close(): Promise<void>;
}

export interface NetPlatform {
	lookup(host: string, family?: NetFamily): Promise<string[]>;
	connect(options: ConnectOptions): Promise<StreamSocket>;
	listen(options: BindOptions): Promise<StreamListener>;
	bindDatagram(options: BindOptions): Promise<DatagramSocket>;
	connectDatagram(options: ConnectDatagramOptions): Promise<DatagramSocket>;
	rootCertificates(): Promise<string[]>;
}

export function createNetPlatform(): NetPlatform | undefined {
	return supportsNodeNet() ? new NodeNetPlatform() : undefined;
}

class NodeNetPlatform implements NetPlatform {
	async lookup(host: string, family?: NetFamily): Promise<string[]> {
		const { lookup } = (await import(
			/* @vite-ignore */ NODE_DNS_MODULE
		)) as typeof import("node:dns/promises");
		const addresses = await lookup(host, { all: true, family: family ?? 0 });
		return addresses.map(({ address }) => address);
	}

	async connect(options: ConnectOptions): Promise<StreamSocket> {
		const { connect } = (await import(
			/* @vite-ignore */ NODE_NET_MODULE
		)) as typeof import("node:net");
		const { signal } = options;
		signal?.throwIfAborted();

		return new Promise((resolve, reject) => {
			const socket = connect({
				host: options.host,
				port: integerPort(options.port),
				family: options.family,
				localAddress: options.localHost || undefined,
				localPort: options.localPort || undefined,
				allowHalfOpen: true,
				noDelay: true,
			});
			const onAbort = () => socket.destroy(signal?.reason ?? new Error("aborted"));
			const settle = () => {
				signal?.removeEventListener("abort", onAbort);
				socket.off("error", onError);
				socket.off("connect", onConnect);
			};
			const onError = (error: Error) => {
				settle();
				reject(error);
			};
			const onConnect = () => {
				settle();
				resolve(new NodeStreamSocket(socket));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			socket.once("error", onError);
			socket.once("connect", onConnect);
		});
	}

	async listen(options: BindOptions): Promise<StreamListener> {
		const { createServer } = (await import(
			/* @vite-ignore */ NODE_NET_MODULE
		)) as typeof import("node:net");
		const server = createServer({ allowHalfOpen: true, noDelay: true });
		const listener = new NodeStreamListener(server);

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			const host = options.host || wildcardHost(options.family);
			server.listen({ host, port: integerPort(options.port) }, () => {
				server.off("error", reject);
				resolve();
			});
		});
		listener.onListening();
		return listener;
	}

	async bindDatagram(options: BindOptions): Promise<DatagramSocket> {
		return new NodeDatagramSocket(await bindWildcardOrHost(options));
	}

	async connectDatagram(options: ConnectDatagramOptions): Promise<DatagramSocket> {
		const type = isIPv6(options.host) ? "udp6" : "udp4";
		const socket = await createBoundSocket(type, options.localHost, options.localPort);
		await new Promise<void>((resolve, reject) => {
			socket.once("error", reject);
			socket.connect(integerPort(options.port), options.host, () => {
				socket.off("error", reject);
				resolve();
			});
		}).catch((error) => {
			socket.close();
			throw error;
		});
		return new NodeDatagramSocket(socket);
	}

	async rootCertificates(): Promise<string[]> {
		const { rootCertificates } = (await import(
			/* @vite-ignore */ NODE_TLS_MODULE
		)) as typeof import("node:tls");
		return [...rootCertificates];
	}
}

class NodeStreamSocket implements StreamSocket {
	local: NetAddress;
	remote: NetAddress;

	private ended = false;
	private closed = false;
	private failure: Error | undefined;
	private wake: (() => void) | undefined;

	constructor(private socket: import("node:net").Socket) {
		this.local = addressOf(socket.localAddress, socket.localPort);
		this.remote = addressOf(socket.remoteAddress, socket.remotePort);

		const wake = () => {
			this.wake?.();
			this.wake = undefined;
		};
		socket.on("readable", wake);
		socket.on("end", () => {
			this.ended = true;
			wake();
		});
		socket.on("error", (error) => {
			this.failure = error;
			wake();
		});
		socket.on("close", () => {
			this.ended = true;
			wake();
		});
	}

	async read(): Promise<Uint8Array | null> {
		for (;;) {
			if (this.closed) throw closedSocketError();
			const chunk = this.socket.read() as Uint8Array | null;
			if (chunk) return chunk;
			if (this.failure) throw this.failure;
			if (this.ended) return null;
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
	}

	write(data: Uint8Array): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.closed) return reject(closedSocketError());
			this.socket.write(data, (error) => (error ? reject(error) : resolve()));
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		this.socket.destroy();
		this.wake?.();
		this.wake = undefined;
	}
}

class NodeStreamListener implements StreamListener {
	local: NetAddress = { host: "", port: 0 };

	private connections: StreamSocket[] = [];
	private waiters: Array<Waiter<StreamSocket>> = [];
	private closed = false;

	constructor(private server: import("node:net").Server) {
		server.on("connection", (socket) => {
			const connection = new NodeStreamSocket(socket);
			const waiter = this.waiters.shift();
			if (waiter) waiter.resolve(connection);
			else this.connections.push(connection);
		});
		server.on("error", (error) => {
			for (const waiter of this.waiters.splice(0)) waiter.reject(error);
		});
	}

	onListening(): void {
		const address = this.server.address();
		if (address && typeof address !== "string")
			this.local = addressOf(address.address, address.port);
	}

	accept(): Promise<StreamSocket> {
		if (this.closed) return Promise.reject(closedSocketError());
		const connection = this.connections.shift();
		if (connection) return Promise.resolve(connection);
		return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter.reject(closedSocketError());
		for (const connection of this.connections.splice(0)) await connection.close();
		// The callback waits for accepted connections, which outlive their listener,
		// but the port is released right away.
		this.server.close();
		await new Promise((resolve) => setImmediate(resolve));
	}
}

class NodeDatagramSocket implements DatagramSocket {
	local: NetAddress;
	remote?: NetAddress;

	private queue: Array<ReceivedDatagram | Error> = [];
	private waiters: Array<Waiter<ReceivedDatagram>> = [];
	private closed = false;
	private isIPv6: boolean;

	constructor(private socket: import("node:dgram").Socket) {
		const local = socket.address();
		this.local = addressOf(local.address, local.port);
		this.isIPv6 = local.family === "IPv6";
		if (isConnected(socket)) {
			const remote = socket.remoteAddress();
			this.remote = addressOf(remote.address, remote.port);
		}

		socket.on("message", (data, sender) => {
			this.deliver({ data, ...addressOf(sender.address, sender.port) });
		});
		// Node.js throws on an unhandled "error" event. A connected socket gets one
		// for ICMP port-unreachable, which Go returns from the next read.
		socket.on("error", (error) => this.deliver(error));
	}

	private deliver(item: ReceivedDatagram | Error): void {
		const waiter = this.waiters.shift();
		if (!waiter) {
			if (this.queue.length < MAX_QUEUED_DATAGRAMS) this.queue.push(item);
			return;
		}
		if (item instanceof Error) waiter.reject(item);
		else waiter.resolve(item);
	}

	receive(): Promise<ReceivedDatagram> {
		if (this.closed) return Promise.reject(closedSocketError());
		const item = this.queue.shift();
		if (item instanceof Error) return Promise.reject(item);
		if (item) return Promise.resolve(item);
		return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
	}

	send(data: Uint8Array, host?: string, port?: number): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.closed) return reject(closedSocketError());
			const done = (error: Error | null) => (error ? reject(error) : resolve());
			if (host === undefined || port === undefined) this.socket.send(data, done);
			else this.socket.send(data, integerPort(port), this.sendHost(host), done);
		});
	}

	/** An IPv6 socket can only reach an IPv4 peer through its mapped address. */
	private sendHost(host: string): string {
		return this.isIPv6 && !isIPv6(host) ? `::ffff:${host}` : host;
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter.reject(closedSocketError());
		await new Promise<void>((resolve) => this.socket.close(() => resolve()));
	}
}

type Waiter<T> = {
	resolve: (value: T) => void;
	reject: (error: Error) => void;
};

async function bindWildcardOrHost(options: BindOptions): Promise<import("node:dgram").Socket> {
	const { host, port, family } = options;
	if (host) return createBoundSocket(isIPv6(host) ? "udp6" : "udp4", host, port);
	if (family === 4) return createBoundSocket("udp4", "0.0.0.0", port);
	if (family === 6) return createBoundSocket("udp6", "::", port);
	try {
		return await createBoundSocket("udp6", "::", port);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL") throw error;
		return createBoundSocket("udp4", "0.0.0.0", port);
	}
}

async function createBoundSocket(
	type: "udp4" | "udp6",
	host?: string,
	port?: number,
): Promise<import("node:dgram").Socket> {
	const { createSocket } = (await import(
		/* @vite-ignore */ NODE_DGRAM_MODULE
	)) as typeof import("node:dgram");
	const socket = createSocket({ type });
	if (!host && !port) return socket;

	return new Promise((resolve, reject) => {
		socket.once("error", reject);
		socket.bind({ address: host || undefined, port: integerPort(port ?? 0) }, () => {
			socket.off("error", reject);
			resolve(socket);
		});
	});
}

/** Numbers from WASM are doubles, and Bun's dgram `connect` silently ignores a double port. */
function integerPort(port: number): number {
	return port | 0;
}

function isConnected(socket: import("node:dgram").Socket): boolean {
	try {
		socket.remoteAddress();
		return true;
	} catch {
		return false;
	}
}

function wildcardHost(family?: NetFamily): string | undefined {
	if (family === 4) return "0.0.0.0";
	if (family === 6) return "::";
	return undefined;
}

function isIPv6(host: string): boolean {
	return host.includes(":");
}

function addressOf(host: string | undefined, port: number | undefined): NetAddress {
	const address = host ?? "";
	return {
		host:
			address.toLowerCase().startsWith("::ffff:") && address.includes(".")
				? address.slice(7)
				: address,
		port: port ?? 0,
	};
}

function closedSocketError(): Error {
	return Object.assign(new Error("use of closed network connection"), { code: CLOSED_SOCKET_CODE });
}

function supportsNodeNet(): boolean {
	return typeof process !== "undefined" && !!process.versions?.node;
}
