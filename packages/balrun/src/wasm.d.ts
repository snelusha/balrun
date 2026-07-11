import type { FS } from "./fs/core";
import type { BallerinaRunOptions } from "./ballerina-core";

declare global {
  class Go {
    importObject: WebAssembly.Imports;
    run(instance: WebAssembly.Instance): Promise<void>;
  }

  var run: (
    proxy: FS,
    path: string,
    options?: BallerinaRunOptions,
  ) => Promise<{ error?: string } | null>;
}
