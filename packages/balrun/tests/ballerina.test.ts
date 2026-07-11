import { describe, expect, it } from "bun:test";

import { Ballerina } from "../src/ballerina.ts";
import { MemFS } from "./memfs";

import type { BallerinaCore, BallerinaRunOptions } from "../src/ballerina-core.ts";
import type { BallerinaOptions } from "../src/ballerina.ts";
import type { FS } from "../src/fs/core.ts";

class SpyCore implements BallerinaCore {
  calls: Array<{ fs: FS; path: string; options?: BallerinaRunOptions }> = [];

  async run(fs: FS, path: string, options?: BallerinaRunOptions) {
    this.calls.push({ fs, path, options });
    return null;
  }
}

describe("Ballerina", () => {
  function createBallerina(options?: BallerinaOptions) {
    const core = new SpyCore();
    const defaultOptions = {
      core,
      fs: new MemFS({ "main.bal": "" }),
      ...options,
    };

    return {
      ballerina: new Ballerina(defaultOptions),
      core,
    };
  }

  it("uses default run options", async () => {
    const { ballerina, core } = createBallerina();

    await ballerina.run("main.bal");
    expect(core.calls).toHaveLength(1);
    expect(core.calls[0]?.path).toBe("main.bal");
    expect(core.calls[0]?.options).toEqual({
      colors: true,
      stdout: undefined,
      stderr: undefined,
    });
  });

  it("allows constructor defaults to disable colors", async () => {
    const { ballerina, core } = createBallerina({ colors: false });

    await ballerina.run("main.bal");
    expect(core.calls[0]?.options?.colors).toBe(false);
  });

  it("overrides defaults with per-run options", async () => {
    const stdout = { write: () => {} };
    const { ballerina, core } = createBallerina({
      colors: false,
    });

    await ballerina.run("main.bal", { colors: true, stdout: stdout });
    expect(core.calls[0]?.options).toMatchObject({
      colors: true,
      stdout: stdout,
      stderr: undefined,
    });
  });

  it("initializes with provided core and fs", async () => {
    const { ballerina, core } = createBallerina();

    expect(ballerina.init()).resolves.toBe(ballerina);
    await ballerina.run("main.bal");

    expect(core.calls).toHaveLength(1);
  });

  it("throws when run path is empty", async () => {
    const { ballerina, core } = createBallerina();

    expect(ballerina.run("")).rejects.toThrow("[balrun]: run path must not be empty.");
    expect(core.calls).toHaveLength(0);
  });

  it("allows retrying initialization after a bridge load failure", async () => {
    const ballerina = new Ballerina({
      fs: new MemFS({ "main.bal": "" }),
      wasmSource: "https://localhost:6969/missing.wasm",
    });

    expect(ballerina.run("main.bal")).rejects.toThrow(
      "[balrun]: failed to initialize the WASM bridge:",
    );
    expect(ballerina.run("main.bal")).rejects.toThrow(
      "[balrun]: failed to initialize the WASM bridge:",
    );
  });
});
