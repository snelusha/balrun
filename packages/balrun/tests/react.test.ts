import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";

import { Ballerina, WasmBridge } from "../src/node";
import { BallerinaProvider, useBallerina } from "../src/react";
import { MemFS } from "../src/core/memfs";

import type { BallerinaCore } from "../src/core/ballerina-core";
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

	const rerender = (options: Omit<BallerinaProviderProps, "children">) =>
		act(async () => {
			root.render(createElement(BallerinaProvider, options, createElement(Consumer)));
		});

	await rerender(options);

	return { container, rerender, root, runtime };
}

describe("React", () => {
	test("BallerinaProvider runs Ballerina code", async () => {
		const fs = new MemFS({
			"main.bal":
				'import ballerina/io;\n\npublic function main() { io:println("Hello, Ballerina!"); }',
		});
		const stdout: string[] = [];
		const { container, root, runtime } = await renderProvider({
			ballerina: new Ballerina({
				core: await WasmBridge.load(WASM_PATH),
				fs,
				colors: false,
				stdout: { write: (chunk) => stdout.push(chunk) },
			}),
		});

		expect(container.innerHTML).toBe("<output>true:null</output>");
		expect(runtime.current).not.toBeNull();
		expect(runtime.current!.run("main.bal")).resolves.toBe(0);
		expect(stdout.join("")).toBe("Hello, Ballerina!\n");

		await act(async () => root.unmount());
	});

	test("BallerinaProvider rejects invalid run paths", async () => {
		const { root, runtime } = await renderProvider({
			ballerina: new Ballerina({ core: await WasmBridge.load(WASM_PATH), fs: new MemFS({}) }),
		});

		expect(runtime.current).not.toBeNull();
		expect(runtime.current!.run("")).rejects.toThrow("[balrun]: run path must not be empty.");

		await act(async () => root.unmount());
	});

	test("BallerinaProvider shares the given instance", async () => {
		const ballerina = new Ballerina({ core: await WasmBridge.load(WASM_PATH), fs: new MemFS({}) });
		const { root, runtime } = await renderProvider({ ballerina });

		expect(runtime.current?.ballerina).toBe(ballerina);
		expect(runtime.current?.isReady).toBe(true);

		await act(async () => root.unmount());
	});

	test("BallerinaProvider reports initialization errors", async () => {
		const { container, root, runtime } = await renderProvider({
			ballerina: new Ballerina({ fs: new MemFS({}), wasmSource: "/tmp/balrun-missing.wasm" }),
		});

		while (!runtime.current?.error) await act(() => Bun.sleep(10));

		expect(runtime.current?.isReady).toBe(false);
		expect(runtime.current?.error?.message).toStartWith(
			"[balrun]: failed to initialize the WASM bridge:",
		);
		expect(runtime.current!.run("main.bal")).rejects.toThrow(
			"[balrun]: runtime instance is not initialized.",
		);
		expect(container.innerHTML).toStartWith("<output>false:Error:");

		await act(async () => root.unmount());
	});

	test("BallerinaProvider clears the error when a failed instance recovers", async () => {
		const fs = new MemFS({});
		const core = {} as BallerinaCore;
		const failing = new Ballerina({ core, fs });
		const init = spyOn(failing, "init").mockRejectedValueOnce(new Error("boom"));

		const { container, rerender, root } = await renderProvider({ ballerina: failing });
		expect(container.innerHTML).toBe("<output>false:Error: boom</output>");

		await rerender({ ballerina: new Ballerina({ core, fs }) });
		await rerender({ ballerina: failing });
		expect(init).toHaveBeenCalledTimes(2);
		expect(container.innerHTML).toBe("<output>true:null</output>");

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
