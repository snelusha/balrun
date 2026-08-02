import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "bun:test";
import { Window } from "happy-dom";

import { BallerinaProvider, useBallerina } from "../src/react";
import { WasmBridge } from "../src/wasm-bridge";
import { MemFS } from "./memfs";

const WASM_PATH = new URL("../dist/ballerina.wasm", import.meta.url).href;

const window = new Window();
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	HTMLElement: window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

test("BallerinaProvider initializes and runs code through the shared runtime", async () => {
	const fs = new MemFS({
		"main.bal":
			'import ballerina/io;\n\npublic function main() { io:println("Hello, Ballerina!"); }',
	});
	const stdout: string[] = [];
	const core = await WasmBridge.load(WASM_PATH);
	let ballerina: ReturnType<typeof useBallerina> | null = null;
	const container = document.createElement("div");
	const root = createRoot(container);

	function Consumer() {
		ballerina = useBallerina();
		return createElement("output", null, `${ballerina.isReady}:${ballerina.error}`);
	}

	await act(async () => {
		root.render(
			createElement(
				BallerinaProvider,
				{ core, fs, colors: false, stdout: { write: (chunk) => stdout.push(chunk) } },
				createElement(Consumer),
			),
		);
	});

	expect(container.innerHTML).toBe("<output>true:null</output>");
	await expect(ballerina?.run("main.bal")).resolves.toBeNull();
	expect(stdout.join("")).toBe("Hello, Ballerina!\n");

	await act(async () => root.unmount());
});

test("useBallerina requires a BallerinaProvider", async () => {
	const container = document.createElement("div");
	const root = createRoot(container);

	function Consumer() {
		useBallerina();
		return null;
	}

	let error: unknown;
	try {
		await act(async () => {
			root.render(createElement(Consumer));
		});
	} catch (err) {
		error = err;
	}

	expect(error).toBeInstanceOf(Error);
	expect(error).toHaveProperty(
		"message",
		"[balrun]: useBallerina must be used within a BallerinaProvider.",
	);
});
