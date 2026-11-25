import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as playwright from "playwright";

import type { BrowserContext, Page } from "playwright";

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const BROWSERS = (process.env.BROWSERS ?? "chromium,firefox,webkit").split(",") as (
	| "chromium"
	| "firefox"
	| "webkit"
)[];

const PROGRAM = `import ballerina/file;
import ballerina/io;

public function main() returns error? {
    check file:createDir("out/nested", file:RECURSIVE);
    check io:fileWriteString("out/a.txt", "one");
    check io:fileWriteString("out/a.txt", " two", io:APPEND);
    check file:rename("out", "renamed");
    io:println((check file:readDir("renamed")).length());
    io:WritableByteChannel channel = check io:openWritableFile("left-open.txt");
    _ = check channel.write("saved".toBytes(), 0);
}`;

type Web = typeof import("../../src/web");

describe.each(BROWSERS)("OPFS in %s", (name) => {
	let profile: string;
	let context: BrowserContext;
	let page: Page;
	let server: ReturnType<typeof Bun.serve>;

	beforeAll(async () => {
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const { pathname } = new URL(request.url);
				if (pathname === "/")
					return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
				const file = Bun.file(DIST + pathname.slice(1));
				return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
			},
		});
		// Temporary contexts count as private browsing, where WebKit has no OPFS.
		profile = await mkdtemp(join(tmpdir(), "balrun-browser-"));
		context = await playwright[name].launchPersistentContext(profile);
		page = await context.newPage();
		await page.goto(`http://localhost:${server.port}/`);
	}, 60_000);

	afterAll(async () => {
		await context?.close();
		await server?.stop(true);
		await rm(profile, { recursive: true, force: true });
	});

	it("keeps a program's files across a reload", async () => {
		const result = await page.evaluate(async (program) => {
			const { Ballerina, OPFS }: Web = await import("/web.mjs" as string);
			const fs = new OPFS({ root: "project" });
			await fs.writeFile("main.bal", program);
			const output: string[] = [];
			const writer = { write: (chunk: string) => output.push(chunk) };
			const ballerina = new Ballerina({ fs, stdout: writer, stderr: writer, colors: false });
			return { exitCode: await ballerina.run("main.bal"), output: output.join("") };
		}, PROGRAM);
		expect(result).toEqual({ exitCode: 0, output: "2\n" });

		await page.reload();
		const files = await page.evaluate(async () => {
			const { OPFS }: Web = await import("/web.mjs" as string);
			const fs = new OPFS({ root: "project" });
			const text = async (path: string) => new TextDecoder().decode(await fs.readFile(path));
			return {
				main: await text("main.bal"),
				renamed: await text("renamed/a.txt"),
				leftOpen: await text("left-open.txt"),
				entries: (await fs.readdir(".")).map((entry) => entry.name).sort(),
			};
		});
		expect(files).toEqual({
			main: PROGRAM,
			renamed: "one two",
			leftOpen: "saved",
			entries: ["left-open.txt", "main.bal", "renamed"],
		});
	}, 60_000);

	it("keeps open files working while their path changes", async () => {
		const result = await page.evaluate(async () => {
			const { OPFS }: Web = await import("/web.mjs" as string);
			const fs = new OPFS({ root: "open" });
			const flags = {
				read: true,
				write: true,
				create: true,
				truncate: false,
				append: false,
				exclusive: false,
			};
			const text = (data: Uint8Array) => new TextDecoder().decode(data);
			await fs.writeFile("a.txt", "content");
			const file = await fs.open("a.txt", flags);
			await file.write?.(0, new TextEncoder().encode("C"));
			await fs.rename("a.txt", "b.txt");
			await fs.writeFile("a.txt", "other");
			const renamed = text(await file.read(0, 10));
			await file.close?.();
			const saved = text(await new OPFS({ root: "open" }).readFile("b.txt"));
			const reader = await fs.open("b.txt", { ...flags, write: false });
			await fs.rm("b.txt", { recursive: false });
			const removed = text(await reader.read(0, 10));
			await reader.close?.();
			return { renamed, saved, removed };
		});
		expect(result).toEqual({ renamed: "Content", saved: "Content", removed: "Content" });
	});

	it("reports error codes", async () => {
		const codes = await page.evaluate(async () => {
			const { OPFS }: Web = await import("/web.mjs" as string);
			const fs = new OPFS({ root: "errors" });
			await fs.mkdir("dir/nested", { recursive: true });
			await fs.writeFile("file", "");
			const codeOf = (operation: Promise<unknown>) =>
				operation.then(
					() => undefined,
					(error: { code?: string }) => error.code,
				);
			return [
				await codeOf(fs.stat("missing")),
				await codeOf(fs.stat("file/child")),
				await codeOf(fs.readFile("dir")),
				await codeOf(fs.readdir("file")),
				await codeOf(fs.mkdir("dir", { recursive: false })),
				await codeOf(fs.rm("dir", { recursive: false })),
				await codeOf(fs.rename("dir", "dir/nested/dir")),
				await codeOf(fs.rename("file", "dir")),
			];
		});
		expect(codes).toEqual([
			"ENOENT",
			"ENOTDIR",
			"EISDIR",
			"ENOTDIR",
			"EEXIST",
			"ENOTEMPTY",
			"EINVAL",
			"EISDIR",
		]);
	});
});
