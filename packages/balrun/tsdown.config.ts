import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/fs/node.ts", "src/react.ts"],
	deps: {
		neverBundle: ["react"],
	},
});
