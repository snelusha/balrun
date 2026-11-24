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

export type HTTPListenerCloseMode = "graceful" | "immediate";

export interface HTTPListenerTransport {
	listen(config: HTTPListenerConfig): Promise<void>;
	close(config: HTTPListenerConfig, mode: HTTPListenerCloseMode): Promise<void>;
	dispatch(request: HTTPDispatchRequest): Promise<HTTPListenerResponse>;
}

export interface HTTPServer {
	readonly address: HTTPListenerReady;
	close(mode: HTTPListenerCloseMode): Promise<void>;
}

export type HTTPServerFactory = (
	config: HTTPListenerConfig,
	handle: (request: HTTPListenerRequest) => Promise<HTTPListenerResponse>,
) => Promise<HTTPServer>;

type Dispatch = (
	listener: HTTPListenerConfig,
	request: HTTPListenerRequest,
) => Promise<HTTPListenerResponse>;

type ListenerRecord = {
	endpoint: HTTPListenerConfig;
	address: HTTPListenerConfig;
	server?: HTTPServer;
};

export function createHTTPListenerTransport(
	dispatch: Dispatch,
	onListenerReady?: (listener: HTTPListenerReady) => void,
	createServer?: HTTPServerFactory,
): HTTPListenerTransport {
	const listeners = new Map<string, ListenerRecord>();

	return {
		async listen(config) {
			const key = listenerKey(config);
			if (listeners.has(key)) throw new Error(`listener already exists: ${key}`);
			if (!createServer) {
				listeners.set(key, { endpoint: config, address: config });
				onListenerReady?.(config);
				return;
			}

			const server = await createServer(config, (request) => dispatch(config, request));
			listeners.set(key, { endpoint: config, address: server.address, server });
			onListenerReady?.(server.address);
		},
		async close(config, mode) {
			const key = listenerKey(config);
			const listener = listeners.get(key);
			if (!listener) return;
			await listener.server?.close(mode);
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

function listenerKey({ host, port }: HTTPListenerConfig): string {
	return `${host.toLowerCase()}:${port}`;
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
