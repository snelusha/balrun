import { createServer } from "node:http";

import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

import type {
	HTTPListenerConfig,
	HTTPListenerReady,
	HTTPListenerRequest,
	HTTPListenerResponse,
	HTTPServerFactory,
} from "../core/http-listener";

const MAX_REQUEST_BODY_SIZE = 1024 * 1024;

type Handle = (request: HTTPListenerRequest) => Promise<HTTPListenerResponse>;

export const nodeHTTPServer: HTTPServerFactory = async (config, handle) => {
	const sockets = new Set<Socket>();
	const server = createServer((request, response) => {
		void handleRequest(request, response, handle);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	try {
		await listen(server, config);
	} catch (error) {
		server.close();
		throw error;
	}

	return {
		address: listenerAddress(server, config),
		async close(mode) {
			if (mode === "immediate") {
				for (const socket of sockets) socket.destroy();
			}
			await close(server);
		},
	};
};

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	handle: Handle,
): Promise<void> {
	try {
		const body = await readBody(request);
		if (!body) {
			response.statusCode = 413;
			response.end();
			return;
		}
		const result = await handle({
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

function headersFromNode(headers: IncomingHttpHeaders): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== undefined) result[name] = Array.isArray(value) ? value : [value];
	}
	return result;
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
