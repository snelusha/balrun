import { Ballerina as CoreBallerina } from "./core/ballerina";
import { WasmBridge as CoreWasmBridge } from "./core/bridge";
import { webPlatform } from "./web/platform";

import type { BallerinaOptions } from "./core/ballerina";
import type { WasmSource } from "./core/bridge";

export * from "./core/index";
export { OPFS } from "./web/opfs";

export type { OPFSOptions } from "./web/opfs";

export const bundledWasmUrl: URL = new URL("./ballerina.wasm", import.meta.url);

const platform = webPlatform(bundledWasmUrl);

export class Ballerina extends CoreBallerina {
	constructor(options?: BallerinaOptions) {
		super(platform, options);
	}
}

export class WasmBridge extends CoreWasmBridge {
	constructor() {
		super(platform);
	}

	static load(source?: WasmSource): Promise<WasmBridge> {
		return new WasmBridge().start(source);
	}
}
