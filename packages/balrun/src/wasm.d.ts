import type { FS } from "./fs/core";
import type { BallerinaRunOptions, BallerinaStopMode } from "./ballerina-core";
import type { HTTPListenerRequest, HTTPListenerResponse } from "./http-listener";

declare global {
	class Go {
		importObject: WebAssembly.Imports;
		run(instance: WebAssembly.Instance): Promise<void>;
	}

	var run: (proxy: FS, path: string, options?: BallerinaRunOptions) => Promise<number>;
	var stop: (mode: BallerinaStopMode) => boolean;
	var dispatchHttpRequest: (
		host: string,
		port: number,
		request: HTTPListenerRequest,
	) => Promise<HTTPListenerResponse>;
}
