import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { openExternalMock, openPathMock, writeTextMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  openPathMock: vi.fn(),
  writeTextMock: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: {
    openExternal: openExternalMock,
    openPath: openPathMock,
  },
  clipboard: {
    writeText: writeTextMock,
  },
}));

import * as ElectronShell from "./ElectronShell.ts";

describe("ElectronShell", () => {
  beforeEach(() => {
    openExternalMock.mockReset();
    openPathMock.mockReset();
    writeTextMock.mockReset();
  });

  it.effect("opens a trusted local document with the OS default application", () =>
    Effect.gen(function* () {
      openPathMock.mockResolvedValue("");
      const guidePath = "/desktop home/local-docs/eli5-product-guide/index.html";
      const electronShell = yield* ElectronShell.ElectronShell;

      yield* electronShell.openPath(guidePath);

      assert.deepEqual(openPathMock.mock.calls, [[guidePath]]);
      assert.isEmpty(openExternalMock.mock.calls);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect.each(["File does not exist", "No application is associated with this file"])(
    "reports the OS file-opening failure: %s",
    (cause) =>
      Effect.gen(function* () {
        openPathMock.mockResolvedValue(cause);
        const guidePath = "/desktop-home/local-docs/eli5-product-guide/index.html";
        const electronShell = yield* ElectronShell.ElectronShell;

        const error = yield* electronShell.openPath(guidePath).pipe(Effect.flip);

        assert.instanceOf(error, ElectronShell.ElectronShellOpenPathError);
        assert.equal(error.filePath, guidePath);
        assert.equal(error.cause, cause);
      }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("reports a rejected file-opening request", () =>
    Effect.gen(function* () {
      const cause = new Error("File opening failed");
      openPathMock.mockRejectedValue(cause);
      const guidePath = "/desktop-home/local-docs/eli5-product-guide/index.html";
      const electronShell = yield* ElectronShell.ElectronShell;

      const error = yield* electronShell.openPath(guidePath).pipe(Effect.flip);

      assert.instanceOf(error, ElectronShell.ElectronShellOpenPathError);
      assert.equal(error.filePath, guidePath);
      assert.equal(error.cause, cause);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("opens remote SSH editor URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal(
        "vscode://vscode-remote/ssh-remote+user%40example.com/home/user/project",
      );

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [
        ["vscode://vscode-remote/ssh-remote+user%40example.com/home/user/project"],
      ]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("opens the JetBrains Toolbox ssh deep link", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const url =
        "jetbrains://gateway/ssh/environment?h=example.com&launchIde=true&ideHint=IU&projectHint=%2Fhome%2Fuser%2Fproject&u=user";
      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal(url);

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [[url]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open editor URLs that mix up link shapes", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const results = yield* Effect.all([
        electronShell.openExternal("zed://extension/attacker"),
        electronShell.openExternal("vscode://ssh/example.com/home/user/project"),
        electronShell.openExternal("jetbrains://idea/navigate/reference?project=x&path=y"),
        electronShell.openExternal("jetbrains://gateway/ssh/environment?launchIde=true"),
        electronShell.openExternal("jetbrains://gateway/com.example.provider/connect?h=x"),
      ]);

      assert.deepEqual(results, [false, false, false, false, false]);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open remote editor URLs with userinfo", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const results = yield* Effect.all([
        electronShell.openExternal(
          "vscode://user@vscode-remote/ssh-remote+example.com/home/user/project",
        ),
        electronShell.openExternal(
          "vscode://:secret@vscode-remote/ssh-remote+example.com/home/user/project",
        ),
        electronShell.openExternal("zed://ssh/user:secret@example.com/home/user/project"),
        electronShell.openExternal("jetbrains://user@gateway/ssh/environment?h=example.com"),
      ]);

      assert.deepEqual(results, [false, false, false, false]);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open unsafe external URLs", () =>
    Effect.gen(function* () {
      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("file:///etc/passwd");

      assert.equal(result, false);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );
});
