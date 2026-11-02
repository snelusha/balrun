import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { MemFS } from "../memfs.ts";
import { formatTxtar, parseTxtar } from "./txtar.ts";

import type { HTTPListenerReady } from "../../src/http-listener.ts";
import type { WasmBridge } from "../../src/wasm-bridge.ts";

const CORPUS_DIR = fileURLToPath(new URL("../corpus/", import.meta.url));
const BAL_DIR = join(CORPUS_DIR, "bal");
const INTEGRATION_DIR = join(CORPUS_DIR, "integration");
const CERTS_DIR = join(CORPUS_DIR, "testdata", "certs");

const CASE_NAME = /-(v|e|p)$/;
const OUTPUT_MARKER = /\/\/\s*@output\b[ \t]?(.*)$/;
const REQUIRES_MARKER = /\/\/\s*@requires\s+(\S+)/;
/** Reserved for corpus programs, so the check below can tell when two cases collide. */
const CORPUS_PORT = /\b19[6-9]\d\d\b/g;
const STOPPED_EXIT_CODE = 130;

export interface CorpusCase {
	name: string;
	sourcePath: string;
	goldenPath: string;
	isProject: boolean;
	browser: boolean;
	hosted: boolean;
}

export interface CaseContext {
	bridge: WasmBridge;
	/** Resolves once stdout contains `text`. */
	stdout(text: string): Promise<void>;
	listener: Promise<HTTPListenerReady>;
}

/** What a program needs from outside Ballerina. */
export interface CaseDriver {
	setup?(): Promise<() => void | Promise<void>>;
	/** Runs alongside the program, for whatever must reach it or stop it. */
	during?(context: CaseContext): Promise<void>;
	/** Additional files for the run, as names mapped to files in testdata/certs. */
	certs?: Record<string, string>;
	/** Repeats the run in the same bridge. Every run must match the golden. */
	runs?: number;
}

interface CaseResult {
	stdout: string;
	stderr: string;
	exitcode: string;
}

export function discoverCases(): CorpusCase[] {
	const cases: CorpusCase[] = [];
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isFile() && entry.name.endsWith(".bal")) cases.push(toCase(path));
			else if (entry.isDirectory() && CASE_NAME.test(entry.name)) cases.push(toCase(path));
			else if (entry.isDirectory()) walk(path);
		}
	};
	walk(BAL_DIR);
	return cases.sort((a, b) => a.name.localeCompare(b.name));
}

function toCase(sourcePath: string): CorpusCase {
	const name = relative(BAL_DIR, sourcePath)
		.replace(/\.bal$/, "")
		.replaceAll("\\", "/");
	return {
		name,
		sourcePath,
		goldenPath: join(INTEGRATION_DIR, `${name}.txtar`),
		isProject: statSync(sourcePath).isDirectory(),
		browser: name.startsWith("browser/"),
		hosted: name.startsWith("hosted/"),
	};
}

function readSources(testCase: CorpusCase): Record<string, string> {
	if (!testCase.isProject) {
		const name = testCase.sourcePath.slice(dirname(testCase.sourcePath).length + 1);
		return { [name]: readFileSync(testCase.sourcePath, "utf8") };
	}
	const files: Record<string, string> = {};
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else
				files[relative(testCase.sourcePath, path).replaceAll("\\", "/")] = readFileSync(
					path,
					"utf8",
				);
		}
	};
	walk(testCase.sourcePath);
	return files;
}

function balSources(sources: Record<string, string>): string[] {
	return Object.entries(sources)
		.filter(([name]) => name.endsWith(".bal"))
		.map(([, content]) => content);
}

/** The reason a case can't run on this machine, if any. */
export function skipReason(testCase: CorpusCase): string | undefined {
	for (const source of balSources(readSources(testCase))) {
		for (const line of source.split("\n")) {
			const requirement = REQUIRES_MARKER.exec(line)?.[1];
			if (requirement === "ipv6" && !hasIPv6Loopback()) return "needs an IPv6 loopback";
			if (requirement && requirement !== "ipv6") {
				throw new Error(`${testCase.name}: unknown @requires ${requirement}`);
			}
		}
	}
	return undefined;
}

function hasIPv6Loopback(): boolean {
	return Object.values(networkInterfaces())
		.flat()
		.some((address) => address?.address === "::1");
}

async function runOnce(
	bridge: WasmBridge,
	testCase: CorpusCase,
	driver: CaseDriver,
	sources: Record<string, string>,
): Promise<CaseResult> {
	const files = { ...sources };
	for (const [name, certificate] of Object.entries(driver.certs ?? {})) {
		files[name] = readFileSync(join(CERTS_DIR, certificate), "utf8");
	}
	const entry = testCase.isProject ? "." : Object.keys(sources)[0];
	if (!entry) throw new Error(`${testCase.name}: no source files`);

	let stdout = "";
	let stderr = "";
	const stdoutWaiters = new Set<() => void>();
	let listenerReady: (listener: HTTPListenerReady) => void = () => {};
	const listener = new Promise<HTTPListenerReady>((resolve) => {
		listenerReady = resolve;
	});
	const context: CaseContext = {
		bridge,
		listener,
		stdout: (text) =>
			new Promise((resolve) => {
				const check = () => {
					if (!stdout.includes(text)) return;
					stdoutWaiters.delete(check);
					resolve();
				};
				stdoutWaiters.add(check);
				check();
			}),
	};

	const host = globalThis.process;
	// A browser has no `process`, which is how the runtime detects one.
	if (testCase.browser) Reflect.set(globalThis, "process", undefined);
	try {
		const run = bridge.run(new MemFS(files), entry, {
			colors: false,
			stdout: {
				write: (chunk) => {
					stdout += chunk;
					for (const waiter of stdoutWaiters) waiter();
				},
			},
			stderr: {
				write: (chunk) => {
					stderr += chunk;
				},
			},
			onListenerReady: (ready) => listenerReady(ready),
		});
		const [exitCode] = await Promise.all([run, driver.during?.(context)]);
		return { stdout, stderr, exitcode: String(exitCode) };
	} finally {
		if (testCase.browser) Reflect.set(globalThis, "process", host);
	}
}

function normalize(text: string): string {
	return text.replaceAll("\r\n", "\n").replace(/\n+$/, "");
}

function mismatch(label: string, expected: string, actual: string): Error {
	return new Error(`${label}\n--- expected ---\n${expected}\n--- actual ---\n${actual}`);
}

/** Holds in update mode too, so a golden can't be regenerated from wrong output. */
function checkSourceExpectations(
	testCase: CorpusCase,
	sources: Record<string, string>,
	result: CaseResult,
) {
	const outputs = balSources(sources).map((source) =>
		source.split("\n").flatMap((line) => {
			const marker = OUTPUT_MARKER.exec(line);
			return marker ? [marker[1] ?? ""] : [];
		}),
	);
	if (outputs.filter((lines) => lines.length > 0).length > 1) {
		throw new Error(`${testCase.name}: @output markers must live in a single file`);
	}
	const expected = normalize(outputs.flat().join("\n"));
	const actual = normalize(result.stdout);
	if (expected !== actual) {
		throw mismatch(`${testCase.name}: stdout does not match @output markers`, expected, actual);
	}

	const exitCode = Number(result.exitcode);
	const kind = CASE_NAME.exec(testCase.name)?.[1];
	if (!kind) throw new Error(`${testCase.name}: name must end in -v, -e, or -p`);
	const valid = exitCode === 0 || exitCode === STOPPED_EXIT_CODE;
	if (kind === "v" ? !valid : valid) {
		throw new Error(
			`${testCase.name}: unexpected exit code ${exitCode} for a -${kind} case\n${result.stderr}`,
		);
	}
}

function checkGolden(testCase: CorpusCase, result: CaseResult) {
	if (!existsSync(testCase.goldenPath)) {
		throw new Error(`${testCase.name}: no golden; run \`bun run test:update\` to create it`);
	}
	const golden = new Map(
		parseTxtar(readFileSync(testCase.goldenPath, "utf8")).map(({ name, data }) => [name, data]),
	);
	for (const section of ["stdout", "stderr", "exitcode"] as const) {
		const expected = golden.get(section);
		if (expected === undefined)
			throw new Error(`${testCase.name}: golden has no ${section} section`);
		if (normalize(expected) !== normalize(result[section])) {
			throw mismatch(
				`${testCase.name}: ${section} differs from golden`,
				normalize(expected),
				normalize(result[section]),
			);
		}
	}
}

function writeGolden(testCase: CorpusCase, result: CaseResult) {
	mkdirSync(dirname(testCase.goldenPath), { recursive: true });
	writeFileSync(
		testCase.goldenPath,
		formatTxtar([
			{ name: "stdout", data: normalize(result.stdout) },
			{ name: "stderr", data: normalize(result.stderr) },
			{ name: "exitcode", data: result.exitcode },
		]),
	);
}

export async function runCase(bridge: WasmBridge, testCase: CorpusCase, driver: CaseDriver = {}) {
	const update = process.env.UPDATE_CORPUS === "1";
	const sources = readSources(testCase);
	const cleanup = await driver.setup?.();
	try {
		for (let run = 0; run < (driver.runs ?? 1); run++) {
			const result = await runOnce(bridge, testCase, driver, sources);
			checkSourceExpectations(testCase, sources, result);
			if (update) writeGolden(testCase, result);
			else checkGolden(testCase, result);
		}
	} finally {
		await cleanup?.();
	}
}

/** Catches what would otherwise silently stop a test from running. */
export function findCorpusProblems(cases: CorpusCase[], driverNames: string[]): string[] {
	const problems: string[] = [];
	const names = new Set(cases.map(({ name }) => name));

	const walk = (directory: string) => {
		if (!existsSync(directory)) return;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (
				!names.has(
					relative(INTEGRATION_DIR, path)
						.replace(/\.txtar$/, "")
						.replaceAll("\\", "/"),
				)
			) {
				problems.push(`golden has no source: ${relative(CORPUS_DIR, path)}`);
			}
		}
	};
	walk(INTEGRATION_DIR);

	const owners = new Map<string, string>();
	for (const testCase of cases) {
		if (!CASE_NAME.test(testCase.name))
			problems.push(`${testCase.name}: must end in -v, -e, or -p`);
		if (testCase.hosted && !driverNames.includes(testCase.name)) {
			problems.push(`${testCase.name}: hosted case has no driver`);
		}
		for (const source of balSources(readSources(testCase))) {
			for (const port of new Set(source.match(CORPUS_PORT))) {
				const owner = owners.get(port);
				if (owner) problems.push(`port ${port} is used by both ${owner} and ${testCase.name}`);
				owners.set(port, testCase.name);
			}
		}
	}
	for (const name of driverNames) {
		if (!names.has(name)) problems.push(`driver has no source: ${name}`);
	}
	return problems;
}

export function caseSourcePath(name: string): string {
	return join(BAL_DIR, `${name}.bal`);
}

export function certPath(name: string): string {
	return join(CERTS_DIR, name);
}
