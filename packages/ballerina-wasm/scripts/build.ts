const packageDir = import.meta.dir + "/..";
const interpreterModule = "github.com/ballerina-nutcracker/ballerina/lib";

function go(args: string[]): string {
	const result = Bun.spawnSync(["go", ...args], {
		cwd: packageDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`go ${args.join(" ")} failed:\n${new TextDecoder().decode(result.stderr)}`);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

const interpreterVersion = go([
	"list",
	"-m",
	"-f",
	"{{with .Replace}}{{.Version}}{{else}}{{.Version}}{{end}}",
	interpreterModule,
]);
if (interpreterVersion === "") throw new Error(`${interpreterModule} has no version in go.mod`);

const download = JSON.parse(
	go(["mod", "download", "-json", `${interpreterModule}@${interpreterVersion}`]),
) as { Origin?: { Hash?: string } };
const interpreterRevision = download.Origin?.Hash;
if (!interpreterRevision)
	throw new Error(`no commit hash for ${interpreterModule}@${interpreterVersion}`);

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
