// Runs the corpus cases that need no host sockets in real Chromium. The Bun suite
// only simulates a browser by hiding `process`, which can't catch a difference
// in the browser's own APIs or in loading the WASM over HTTP.
import { chromium } from "playwright";

import {
	checkGolden,
	checkSourceExpectations,
	discoverCases,
	entryPoint,
	readSources,
} from "../harness/corpus.ts";

const CASE_PREFIXES = ["browser/", "core/", "project/"];
const CASE_TIMEOUT_MS = 30_000;

const build = await Bun.build({
	entrypoints: [new URL("entry.ts", import.meta.url).pathname],
	target: "browser",
});
if (!build.success) throw new Error("failed to bundle the browser entry");
const script = await build.outputs[0]?.text();

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(request) {
		switch (new URL(request.url).pathname) {
			case "/":
				return new Response('<!doctype html><script type="module" src="/entry.js"></script>', {
					headers: { "content-type": "text/html" },
				});
			case "/entry.js":
				return new Response(script, { headers: { "content-type": "text/javascript" } });
			case "/ballerina.wasm":
				return new Response(Bun.file(new URL("../../dist/ballerina.wasm", import.meta.url)), {
					headers: { "content-type": "application/wasm" },
				});
			default:
				return new Response("not found", { status: 404 });
		}
	},
});

const browser = await chromium.launch();
const failures: string[] = [];
let passed = 0;
try {
	const page = await browser.newPage();
	page.setDefaultTimeout(CASE_TIMEOUT_MS);
	await page.goto(server.url.href);
	await page.waitForFunction(() => "runCase" in globalThis);

	const cases = discoverCases().filter(({ name }) =>
		CASE_PREFIXES.some((prefix) => name.startsWith(prefix)),
	);
	for (const testCase of cases) {
		try {
			const sources = readSources(testCase);
			const result = await Promise.race([
				page.evaluate(
					([files, entry]) =>
						Reflect.get(globalThis, "runCase")(files, entry) as Promise<{
							stdout: string;
							stderr: string;
							exitcode: string;
						}>,
					[sources, entryPoint(testCase, sources)] as const,
				),
				Bun.sleep(CASE_TIMEOUT_MS).then(() => {
					throw new Error(`${testCase.name}: timed out`);
				}),
			]);
			checkSourceExpectations(testCase, sources, result);
			checkGolden(testCase, result);
			passed++;
		} catch (error) {
			failures.push(testCase.name);
			console.error(`FAIL ${testCase.name}\n${error instanceof Error ? error.message : error}\n`);
		}
	}
	if (cases.length === 0) failures.push("no cases found");
} finally {
	await browser.close();
	await server.stop(true);
}

console.log(`${passed} passed, ${failures.length} failed in Chromium`);
process.exit(failures.length > 0 ? 1 : 0);
