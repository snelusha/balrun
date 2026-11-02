const NODE_NET_MODULE = "node:net";
const NODE_TLS_MODULE = "node:tls";
const NODE_DGRAM_MODULE = "node:dgram";
const NODE_DNS_MODULE = "node:dns/promises";

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
	): Promise<StreamHandle>;
	listen(network: string, address: string, tls?: TLSOptions): Promise<ListenerHandle>;
	dialPacket(network: string, address: string, localAddress: string): Promise<PacketHandle>;
	listenPacket(network: string, address: string): Promise<PacketHandle>;
	resolvePacketAddr(network: string, address: string): Promise<SocketAddress>;
}

export interface StreamHandle {
	read(size: number, deadlineUnixMillis?: number): Promise<Uint8Array | null>;
	write(data: Uint8Array): Promise<number>;
	close(): Promise<void>;
	localAddress(): Promise<SocketAddress>;
	remoteAddress(): Promise<SocketAddress>;
}

export interface ListenerHandle {
	accept(): Promise<StreamHandle>;
	close(): Promise<void>;
	address(): Promise<SocketAddress>;
}

export interface PacketHandle {
	readFrom(
		size: number,
		deadlineUnixMillis?: number,
	): Promise<{ data: Uint8Array; address: SocketAddress } | null>;
	writeTo(data: Uint8Array, address?: SocketAddress): Promise<number>;
	close(): Promise<void>;
	localAddress(): Promise<SocketAddress>;
}

export function createNetPlatform(): NetPlatform {
	return new NodeNetPlatform();
}

class NodeNetPlatform implements NetPlatform {
	async dial(
		network: string,
		address: string,
		localAddress: string,
		tls?: TLSOptions,
	): Promise<StreamHandle> {
		if (network !== "tcp" && network !== "tcp4" && network !== "tcp6") {
			throw new Error(`unsupported stream network: ${network}`);
		}
		const { address: host, port } = parseAddress(address);
		if (host === "") throw new Error(`invalid remote socket address: ${address}`);
		const local = localAddress === "" ? undefined : parseAddress(localAddress);
		const socket = tls
			? await connectTLS(host, port, local, tls)
			: await connectTCP(host, port, local);
		return new NodeStream(socket);
	}

	async listen(network: string, address: string, tls?: TLSOptions): Promise<ListenerHandle> {
		if (network !== "tcp" && network !== "tcp4" && network !== "tcp6") {
			throw new Error(`unsupported stream network: ${network}`);
		}
		const { address: host, port } = parseAddress(address);
		const server = tls ? await createTLSServer(tls) : (await nodeNet()).createServer();
		const listener = new NodeListener(server);
		if (tls) server.on("secureConnection", (socket) => listener.push(socket));
		else server.on("connection", (socket) => listener.push(socket));
		await listen(server, host || undefined, port);
		return listener;
	}

	async dialPacket(network: string, address: string, localAddress: string): Promise<PacketHandle> {
		const type = udpType(network);
		const remote = parseAddress(address);
		if (remote.address === "") throw new Error(`invalid remote socket address: ${address}`);
		const socket = (await nodeDgram()).createSocket(type);
		if (localAddress !== "") {
			const local = parseAddress(localAddress);
			await bind(socket, local.address || undefined, local.port);
		}
		await connectDatagram(socket, remote.address, remote.port);
		return new NodePacket(socket, remote);
	}

	async listenPacket(network: string, address: string): Promise<PacketHandle> {
		const local = parseAddress(address);
		const socket = (await nodeDgram()).createSocket(udpType(network));
		await bind(socket, local.address || undefined, local.port);
		return new NodePacket(socket);
	}

	async resolvePacketAddr(network: string, address: string): Promise<SocketAddress> {
		const target = parseAddress(address);
		const family = network === "udp4" ? 4 : network === "udp6" ? 6 : 0;
		const resolved = await (await nodeDNS()).lookup(target.address, { family });
		return { address: resolved.address, port: target.port, family: `IPv${resolved.family}` };
	}
}

class NodeStream implements StreamHandle {
	private chunks: Uint8Array[] = [];
	private ended = false;
	private failure: Error | null = null;
	private waiter: (() => void) | null = null;

	constructor(private socket: import("node:net").Socket) {
		socket.on("data", (chunk: Uint8Array) => this.push(chunk));
		socket.once("end", () => this.finish());
		socket.once("close", () => this.finish());
		socket.once("error", (error: Error) => this.fail(error));
	}

	async read(size: number, deadlineUnixMillis?: number): Promise<Uint8Array | null> {
		while (this.chunks.length === 0 && !this.ended && !this.failure) {
			await withDeadline(
				new Promise<void>((resolve) => (this.waiter = resolve)),
				deadlineUnixMillis,
			);
		}
		if (this.failure) throw this.failure;
		const chunk = this.chunks.shift();
		if (!chunk) return null;
		if (chunk.length <= size) return chunk;
		this.chunks.unshift(chunk.slice(size));
		return chunk.slice(0, size);
	}

	async write(data: Uint8Array): Promise<number> {
		await new Promise<void>((resolve, reject) => {
			this.socket.write(data, (error) => (error ? reject(error) : resolve()));
		});
		return data.length;
	}

	async close(): Promise<void> {
		this.socket.destroy();
	}

	async localAddress(): Promise<SocketAddress> {
		return socketAddress(this.socket.address() as import("node:net").AddressInfo | string | null);
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

	private push(chunk: Uint8Array): void {
		this.chunks.push(chunk);
		this.wake();
	}

	private finish(): void {
		this.ended = true;
		this.wake();
	}

	private fail(error: Error): void {
		this.failure = error;
		this.wake();
	}

	private wake(): void {
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.();
	}
}

class NodeListener implements ListenerHandle {
	private pending: NodeStream[] = [];
	private waiter: ((stream: NodeStream) => void) | null = null;

	constructor(private server: import("node:net").Server) {}

	push(socket: import("node:net").Socket): void {
		const stream = new NodeStream(socket);
		const waiter = this.waiter;
		this.waiter = null;
		if (waiter) waiter(stream);
		else this.pending.push(stream);
	}

	async accept(): Promise<StreamHandle> {
		const stream = this.pending.shift();
		if (stream) return stream;
		return new Promise((resolve) => (this.waiter = resolve));
	}

	async close(): Promise<void> {
		await new Promise<void>((resolve, reject) =>
			this.server.close((error) => (error ? reject(error) : resolve())),
		);
	}

	async address(): Promise<SocketAddress> {
		return socketAddress(this.server.address() as import("node:net").AddressInfo | string | null);
	}
}

class NodePacket implements PacketHandle {
	private messages: { data: Uint8Array; address: SocketAddress }[] = [];
	private waiter: (() => void) | null = null;
	private closed = false;

	constructor(
		private socket: import("node:dgram").Socket,
		private remote?: SocketAddress,
	) {
		socket.on("message", (data, info) => {
			this.messages.push({
				data,
				address: { address: info.address, port: info.port, family: info.family },
			});
			this.wake();
		});
		socket.once("close", () => {
			this.closed = true;
			this.wake();
		});
	}

	async readFrom(
		size: number,
		deadlineUnixMillis?: number,
	): Promise<{ data: Uint8Array; address: SocketAddress } | null> {
		while (this.messages.length === 0 && !this.closed) {
			await withDeadline(
				new Promise<void>((resolve) => (this.waiter = resolve)),
				deadlineUnixMillis,
			);
		}
		const message = this.messages.shift();
		if (!message) return null;
		return { ...message, data: message.data.slice(0, size) };
	}

	async writeTo(data: Uint8Array, address?: SocketAddress): Promise<number> {
		await new Promise<void>((resolve, reject) => {
			const done = (error: Error | null) => (error ? reject(error) : resolve());
			if (address) this.socket.send(data, address.port, address.address, done);
			else if (this.remote) this.socket.send(data, done);
			else reject(new Error("packet destination is required"));
		});
		return data.length;
	}

	async close(): Promise<void> {
		this.socket.close();
	}

	async localAddress(): Promise<SocketAddress> {
		const address = this.socket.address();
		return { address: address.address, port: address.port, family: address.family };
	}

	private wake(): void {
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.();
	}
}

async function nodeNet(): Promise<typeof import("node:net")> {
	return import(/* @vite-ignore */ NODE_NET_MODULE);
}
async function nodeDgram(): Promise<typeof import("node:dgram")> {
	return import(/* @vite-ignore */ NODE_DGRAM_MODULE);
}
async function nodeDNS(): Promise<typeof import("node:dns/promises")> {
	return import(/* @vite-ignore */ NODE_DNS_MODULE);
}

async function connectTCP(
	host: string,
	port: number,
	local?: SocketAddress,
): Promise<import("node:net").Socket> {
	const socket = (await nodeNet()).connect({
		host,
		port,
		localAddress: local?.address,
		localPort: local?.port,
	});
	await onceConnected(socket, "connect");
	return socket;
}

async function connectTLS(
	host: string,
	port: number,
	local: SocketAddress | undefined,
	options: TLSOptions,
): Promise<import("node:tls").TLSSocket> {
	const tls = (await import(/* @vite-ignore */ NODE_TLS_MODULE)) as typeof import("node:tls");
	const socket = tls.connect({
		host,
		port,
		localAddress: local?.address,
		localPort: local?.port,
		rejectUnauthorized: !options.insecureSkipVerify,
		servername: options.serverName || host,
		ca: toBuffer(options.ca),
		cert: toBuffer(options.cert),
		key: toBuffer(options.key),
		ciphers: options.cipherSuites?.join(":"),
		minVersion: tlsVersion(options.minVersion),
		maxVersion: tlsVersion(options.maxVersion),
		secureOptions: options.disableSessionTickets ? 0x00004000 : undefined,
		checkServerIdentity: options.skipHostnameVerification ? () => undefined : undefined,
	} as import("node:tls").ConnectionOptions);
	await onceConnected(socket, "secureConnect");
	return socket;
}

async function createTLSServer(options: TLSOptions): Promise<import("node:net").Server> {
	const tls = (await import(/* @vite-ignore */ NODE_TLS_MODULE)) as typeof import("node:tls");
	return tls.createServer({
		cert: toBuffer(options.cert),
		key: toBuffer(options.key),
		ca: toBuffer(options.ca),
		ciphers: options.cipherSuites?.join(":"),
		minVersion: tlsVersion(options.minVersion),
		maxVersion: tlsVersion(options.maxVersion),
		requestCert: !!options.ca?.length,
		rejectUnauthorized: !!options.ca?.length,
	});
}

function onceConnected(socket: import("node:net").Socket, event: string): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once(event, resolve);
		socket.once("error", reject);
	});
}

function listen(
	server: import("node:net").Server,
	host: string | undefined,
	port: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
		server.listen({ host, port });
	});
}

function bind(
	socket: import("node:dgram").Socket,
	address: string | undefined,
	port: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once("listening", resolve);
		socket.once("error", reject);
		socket.bind(port, address);
	});
}

function connectDatagram(
	socket: import("node:dgram").Socket,
	address: string,
	port: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once("error", reject);
		socket.connect(port, address, resolve);
	});
}

function parseAddress(value: string): SocketAddress {
	const match = value.match(/^\[([^\]]+)]:(\d+)$/) ?? value.match(/^([^:]*):(\d+)$/);
	if (!match || match[2] === undefined) throw new Error(`invalid socket address: ${value}`);
	return { address: match[1] ?? "", port: Number(match[2]) };
}

function socketAddress(address: string | import("node:net").AddressInfo | null): SocketAddress {
	if (!address || typeof address === "string") throw new Error("socket has no IP address");
	return { address: address.address, port: address.port, family: address.family };
}

function withDeadline<T>(promise: Promise<T>, deadlineUnixMillis?: number): Promise<T> {
	if (!deadlineUnixMillis) return promise;
	const delay = deadlineUnixMillis - Date.now();
	if (delay <= 0) return Promise.reject(new Error("[balrun]: network operation timed out"));
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("[balrun]: network operation timed out")),
			delay,
		);
		void promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function toBuffer(value: Uint8Array | undefined): Buffer | undefined {
	return value?.length ? Buffer.from(value) : undefined;
}

function tlsVersion(value: number | undefined): "TLSv1.2" | "TLSv1.3" | undefined {
	if (value === 0x0303) return "TLSv1.2";
	if (value === 0x0304) return "TLSv1.3";
	return undefined;
}

function udpType(network: string): "udp4" | "udp6" {
	if (network === "udp" || network === "udp4") return "udp4";
	if (network === "udp6") return "udp6";
	throw new Error(`unsupported packet network: ${network}`);
}
