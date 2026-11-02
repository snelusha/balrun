import { strict as assert } from "node:assert";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createTLSServer } from "node:tls";

import { certPath } from "./corpus.ts";

import type { Socket } from "node:net";
import type { CaseDriver } from "./corpus.ts";

function answerLdapBinds(socket: Socket): void {
	socket.on("data", (data) => {
		const message = Buffer.from(data);
		if (message[0] !== 0x30 || message[5] !== 0x60) return;
		const messageId = message.readUInt8(4);
		socket.write(
			Uint8Array.of(0x30, 0x0c, 0x02, 0x01, messageId, 0x61, 0x07, 0x0a, 0x01, 0, 0x04, 0, 0x04, 0),
		);
	});
	socket.on("error", () => {});
}

function ldapServer(port: number, secure = false): () => Promise<() => void> {
	return async () => {
		const server = secure
			? createTLSServer(
					{
						cert: readFileSync(certPath("server-cert.pem")),
						key: readFileSync(certPath("server-key.pem")),
					},
					answerLdapBinds,
				).on("tlsClientError", () => {})
			: createServer({ allowHalfOpen: true }, answerLdapBinds);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", resolve);
		});
		return () => {
			server.close();
		};
	};
}

const CUSTOM_CA = { "ca.pem": "server-cert.pem" };

export const drivers: Record<string, CaseDriver> = {
	"hosted/core/stop-graceful-v": {
		during: async ({ bridge, stdout }) => {
			await stdout("ready\n");
			assert.equal(bridge.stop("graceful"), true);
		},
	},

	"hosted/http/listener-v": {
		during: async ({ bridge, listener }) => {
			const { host, port } = await listener();
			const origin = `http://${host}:${port}`;

			const response = await fetch(`${origin}/ping`);
			assert.equal(response.status, 200);
			assert.equal(await response.text(), "pong");
			assert.equal(response.headers.get("x-reply"), "one, two");

			const dispatched = await bridge.dispatchHttpRequest({
				host: "localhost",
				port,
				path: "/ping",
			});
			assert.equal(new TextDecoder().decode(dispatched.body), "pong");

			const inspected = await fetch(`${origin}/inspect?name=balrun`, {
				headers: { "X-Test": "request-header" },
			});
			assert.equal(await inspected.text(), "balrun|request-header");

			for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
				const echoed = await fetch(`${origin}/echo`, { method, body: `${method} body` });
				assert.equal(echoed.status, 200);
				assert.equal(await echoed.text(), `${method} body`);
			}
			const tooLarge = await fetch(`${origin}/echo`, {
				method: "POST",
				body: "x".repeat(1024 * 1024 + 1),
			});
			assert.equal(tooLarge.status, 413);
			const head = await fetch(`${origin}/echo`, { method: "HEAD" });
			assert.equal(head.status, 200);
			assert.equal(await head.text(), "");
			const options = await fetch(`${origin}/echo`, { method: "OPTIONS" });
			assert.equal(options.status, 200);
			assert.equal(await options.text(), "options");

			const missing = await fetch(`${origin}/`);
			assert.equal(missing.status, 404);
			assert.equal(
				((await missing.json()) as { message: string }).message,
				"no matching resource found for path",
			);
			assert.equal(bridge.stop("graceful"), true);
		},
	},

	"hosted/udp/external-peer-v": {
		during: async ({ bridge, whileRunning }) => {
			const peer = createSocket("udp4");
			const reply = new Promise<string>((resolve) =>
				peer.once("message", (message) => resolve(message.toString())),
			);
			const retry = setInterval(() => peer.send("ping", 19605, "127.0.0.1"), 50);
			try {
				assert.equal(await whileRunning(reply), "ping");
			} finally {
				clearInterval(retry);
				peer.close();
			}
			assert.equal(bridge.stop("graceful"), true);
		},
	},

	"hosted/udp/releases-leaked-sockets-p": { runs: 2 },

	"hosted/ldap/bind-v": { setup: ldapServer(19620) },
	"hosted/ldap/tls-custom-ca-v": { setup: ldapServer(19621, true), certs: CUSTOM_CA },
	"hosted/ldap/tls-wrong-hostname-v": { setup: ldapServer(19622, true), certs: CUSTOM_CA },
	"hosted/ldap/tls-skip-hostname-v": { setup: ldapServer(19623, true), certs: CUSTOM_CA },
	"hosted/ldap/tls-unknown-ca-v": { setup: ldapServer(19624, true) },
};
