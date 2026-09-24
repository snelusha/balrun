import { readFileSync } from "node:fs";

import { defineConfig } from "tsdown";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
	entry: ["src/index.ts", "src/fs/node.ts", "src/react.ts"],
	deps: {
		neverBundle: ["react"],
	},
	define: {
		__BALRUN_VERSION__: JSON.stringify(version),
	},
});
