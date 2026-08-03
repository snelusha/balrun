import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { BallerinaProvider, useBallerina } from "../src/react";

import { WasmBridge } from "../src/wasm-bridge";
import { MemFS } from "./memfs";

import type { BallerinaProviderProps } from "../src/react";

const WASM_PATH = new URL("../dist/ballerina.wasm", import.meta.url).href;

const window = new Window();
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	HTMLElement: window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

async function renderProvider(options: Omit<BallerinaProviderProps, "children">) {
	const runtime: { current: ReturnType<typeof useBallerina> | null } = { current: null };
	const container = document.createElement("div");
	const root = createRoot(container);

	function Consumer() {
		const ballerina = useBallerina();
		runtime.current = ballerina;
		return createElement("output", null, `${ballerina.isReady}:${ballerina.error}`);
	}

	await act(async () => {
		root.render(createElement(BallerinaProvider, options, createElement(Consumer)));
	});

	return { container, root, runtime };
}

describe("React", () => {
	test("BallerinaProvider runs Ballerina code", async () => {
		const fs = new MemFS({
			"main.bal":
				'import ballerina/io;\n\npublic function main() { io:println("Hello, Ballerina!"); }',
		});
		const stdout: string[] = [];
		const { container, root, runtime } = await renderProvider({
			core: await WasmBridge.load(WASM_PATH),
			fs,
			colors: false,
			stdout: { write: (chunk) => stdout.push(chunk) },
		});

		expect(container.innerHTML).toBe("<output>true:null</output>");
		expect(runtime.current).not.toBeNull();
		expect(runtime.current!.run("main.bal")).resolves.toBe(0);
		expect(stdout.join("")).toBe("Hello, Ballerina!\n");

		await act(async () => root.unmount());
	});

	test("BallerinaProvider rejects invalid run paths", async () => {
		const { root, runtime } = await renderProvider({
			core: await WasmBridge.load(WASM_PATH),
			fs: new MemFS({}),
		});

		expect(runtime.current).not.toBeNull();
		expect(runtime.current!.run("")).rejects.toThrow("[balrun]: run path must not be empty.");

		await act(async () => root.unmount());
	});

	test("useBallerina requires a BallerinaProvider", () => {
		function Consumer() {
			useBallerina();
			return null;
		}

		expect(() => renderToStaticMarkup(createElement(Consumer))).toThrow(
			"[balrun]: useBallerina must be used within a BallerinaProvider.",
		);
	});
});
