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

  it.effect("opens only the Grok Bot prompt link", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const prompt = "grokbot://app/v1/prompt?text=Add%20the%20MCP%20server";
      const electronShell = yield* ElectronShell.ElectronShell;
      const results = yield* Effect.forEach(
        [
          prompt,
          "grokbot://app",
          "grokbot://app/v1/prompt?id=bot&text=hi",
          "grokbot://app/v1/prompt?text=a&text=b",
          "grokbot://app/v1/other?text=hi",
          "grokbot://app/v1/prompt?text=hi#x",
          "grokbot://:secret@app/v1/prompt?text=hi",
          "grokbot://user@app/v1/prompt?text=hi",
          "grokbot://other/v1/prompt?text=hi",
          "other://app/v1/prompt?text=hi",
        ],
        (url) => electronShell.openExternal(url),
      );

      assert.deepEqual(results, [true, ...Array<boolean>(9).fill(false)]);
      assert.deepEqual(openExternalMock.mock.calls, [[prompt]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("opens local editor file deep links", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const urls = [
        "cursor://file/Users/me/repo/file.md:186",
        "vscode://file/Users/me/repo/file.md:3:7",
        "vscode-insiders://file/Users/me/repo/file.md",
        "vscodium://file/C:/Users/me/repo/file.md:3",
      ];
      const electronShell = yield* ElectronShell.ElectronShell;
      const results = yield* Effect.forEach(urls, (url) => electronShell.openExternal(url));

      assert.deepEqual(results, [true, true, true, true]);
      assert.deepEqual(
        openExternalMock.mock.calls,
        urls.map((url) => [url]),
      );
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("normalizes the scheme case of local editor file deep links", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("VSCode://file/Users/me/repo/file.md:3");

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [["vscode://file/Users/me/repo/file.md:3"]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open editor URLs that are not absolute local file links", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const results = yield* Effect.forEach(
        [
          "cursor://user@file/Users/me/repo/file.md",
          "cursor://:secret@file/Users/me/repo/file.md",
          "cursor://file:8080/Users/me/repo/file.md",
          "cursor://anysphere.cursor-deeplink/prompt?text=hi",
          "vscode://vscode.git/clone?url=https%3A%2F%2Fexample.com%2Frepo.git",
          "cursor://file",
          "cursor://file/",
          "cursor:file/Users/me/repo/file.md",
          "foo://file/Users/me/repo/file.md",
          "zed://file/Users/me/repo/file.md",
          "jetbrains://file/Users/me/repo/file.md",
          "javascript:alert(1)",
        ],
        (url) => electronShell.openExternal(url),
      );

      assert.deepEqual(results, Array(12).fill(false));
      assert.equal(openExternalMock.mock.calls.length, 0);
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
