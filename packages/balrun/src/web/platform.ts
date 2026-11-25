import { EnvOSPlatform } from "../core/os";

import type { Platform } from "../core/platform";

export function webPlatform(wasm: URL): Platform {
	return {
		wasm,
		createOS: (environment) => new EnvOSPlatform(environment),
	};
}
