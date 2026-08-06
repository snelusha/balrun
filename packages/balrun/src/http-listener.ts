import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";

const NODE_HTTP_MODULE = "node:http";
const MAX_REQUEST_BODY_SIZE = 1024 * 1024;

export interface HTTPListenerConfig {
	host: string;
	port: number;
}

export interface HTTPListenerRequest {
	method: string;
	path: string;
	host: string;
	headers: Record<string, string[]>;
	body: Uint8Array;
}

export interface HTTPListenerResponse {
	statusCode: number;
	headers: Record<string, string[]>;
	body: Uint8Array;
}

export interface HTTPListenerReady {
	host: string;
	port: number;
}

export interface HTTPDispatchRequest {
	host: string;
	port: number;
	path?: string;
	query?: string;
	method?: string;
	headers?: Record<string, string | string[]>;
	body?: string | Uint8Array;
}

export interface HTTPListenerTransport {
	listen(config: HTTPListenerConfig): Promise<void>;
	close(config: HTTPListenerConfig, mode: "graceful" | "immediate"): Promise<void>;
	dispatch(request: HTTPDispatchRequest): Promise<HTTPListenerResponse>;
}

type Dispatch = (
	listener: HTTPListenerConfig,
	request: HTTPListenerRequest,
) => Promise<HTTPListenerResponse>;

type ListenerRecord = {
	endpoint: HTTPListenerConfig;
	address: HTTPListenerConfig;
	server?: Server;
	sockets?: Set<import("node:net").Socket>;
};

export function createHTTPListenerTransport(
	dispatch: Dispatch,
	onListenerReady?: (listener: HTTPListenerReady) => void,
): HTTPListenerTransport {
	const listeners = new Map<string, ListenerRecord>();

	return {
		async listen(config) {
			const key = listenerKey(config);
			if (listeners.has(key)) throw new Error(`listener already exists: ${key}`);
			if (!supportsNodeHTTP()) {
				listeners.set(key, { endpoint: config, address: config });
				onListenerReady?.(config);
				return;
			}

			const { createServer } = (await import(
				/* @vite-ignore */ NODE_HTTP_MODULE
			)) as typeof import("node:http");
			const sockets = new Set<import("node:net").Socket>();
			const server = createServer((request, response) => {
				void dispatchRequest(config, request, response, dispatch);
			});
			server.on("connection", (socket) => {
				sockets.add(socket);
				socket.on("close", () => sockets.delete(socket));
			});

			try {
				await listen(server, config);
				const address = listenerAddress(server, config);
				listeners.set(key, { endpoint: config, address, server, sockets });
				onListenerReady?.(address);
			} catch (error) {
				server.close();
				throw error;
			}
		},
		async close(config, mode) {
			const key = listenerKey(config);
			const listener = listeners.get(key);
			if (!listener) return;
			if (mode === "immediate") {
				for (const socket of listener.sockets ?? []) socket.destroy();
			}
			if (listener.server) await close(listener.server);
			listeners.delete(key);
		},
		async dispatch(request) {
			const listener = [...listeners.values()].find((candidate) =>
				matchesHost(candidate.address, request.host.toLowerCase(), request.port),
			);
			if (!listener) throw new Error(`no service listening on ${request.host}:${request.port}`);
			return dispatch(listener.endpoint, {
				method: request.method ?? "GET",
				path: requestPath(request.path, request.query),
				host: requestAuthority(request.host, request.port),
				headers: requestHeaders(request.headers),
				body: requestBody(request.body),
			});
		},
	};
}

async function dispatchRequest(
	listener: HTTPListenerConfig,
	request: IncomingMessage,
	response: ServerResponse,
	dispatch: Dispatch,
): Promise<void> {
	try {
		const body = await readBody(request);
		if (!body) {
			response.statusCode = 413;
			response.end();
			return;
		}
		const result = await dispatch(listener, {
			method: request.method ?? "GET",
			path: request.url ?? "/",
			host: request.headers.host ?? "localhost",
			headers: headersFromNode(request.headers),
			body,
		});
		response.writeHead(result.statusCode, result.headers);
		response.end(result.body);
	} catch {
		if (!response.headersSent) response.statusCode = 500;
		response.end();
	}
}

function listenerKey({ host, port }: HTTPListenerConfig): string {
	return `${host.toLowerCase()}:${port}`;
}

function listen(server: Server, config: HTTPListenerConfig): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen({ host: config.host, port: config.port });
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

function listenerAddress(server: Server, config: HTTPListenerConfig): HTTPListenerReady {
	const address = server.address();
	if (address && typeof address !== "string") {
		return { host: address.address, port: address.port };
	}
	return config;
}

function requestAuthority(host: string, port: number): string {
	const formattedHost = host.includes(":") ? `[${host}]` : host;
	return `${formattedHost}:${port}`;
}

function matchesHost(config: HTTPListenerConfig, host: string, port: number): boolean {
	if (config.port !== port) return false;
	const configuredHost = config.host.toLowerCase();
	if (configuredHost === host) return true;
	if (configuredHost === "0.0.0.0" || configuredHost === "::") return true;
	return isLoopbackHost(configuredHost) && isLoopbackHost(host);
}

function isLoopbackHost(host: string): boolean {
	return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function requestPath(path = "/", query?: string): string {
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	if (!query) return normalizedPath;
	return `${normalizedPath}?${query.startsWith("?") ? query.slice(1) : query}`;
}

function requestHeaders(headers: HTTPDispatchRequest["headers"]): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		result[name] = Array.isArray(value) ? value : [value];
	}
	return result;
}

function requestBody(body: HTTPDispatchRequest["body"]): Uint8Array {
	if (typeof body === "string") return new TextEncoder().encode(body);
	return body ?? new Uint8Array();
}

function headersFromNode(headers: IncomingHttpHeaders): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== undefined) result[name] = Array.isArray(value) ? value : [value];
	}
	return result;
}

function supportsNodeHTTP(): boolean {
	return typeof process !== "undefined" && !!process.versions?.node;
}

async function readBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	let tooLarge = false;
	for await (const chunk of request) {
		if (tooLarge) continue;
		const bytes = chunk as Uint8Array;
		length += bytes.byteLength;
		if (length > MAX_REQUEST_BODY_SIZE) {
			tooLarge = true;
			continue;
		}
		chunks.push(bytes);
	}
	if (tooLarge) return;
	const body = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}
