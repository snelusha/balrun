import { join } from "node:path";

const packageDir = import.meta.dir + "/..";
const interpreterDir = join(packageDir, "ballerina");

function git(args: string[], fallback: string): string {
	const result = Bun.spawnSync(["git", "-C", interpreterDir, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return fallback;

	const value = new TextDecoder().decode(result.stdout).trim();
	return value === "" ? fallback : value;
}

const interpreterVersion = git(["describe", "--tags", "--abbrev=0"], "dev");
const interpreterRevision = git(["rev-parse", "HEAD"], "unknown");
const result = Bun.spawnSync(
	[
		"go",
		"build",
		"-ldflags",
		`-X main.interpreterVersion=${interpreterVersion} -X main.interpreterRevision=${interpreterRevision}`,
		"-o",
		"dist/ballerina.wasm",
		".",
	],
	{
		cwd: packageDir,
		env: { ...process.env, GOOS: "js", GOARCH: "wasm" },
		stdout: "inherit",
		stderr: "inherit",
	},
);

process.exit(result.exitCode);
