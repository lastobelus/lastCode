// @effect-diagnostics nodeBuiltinImport:off -- These fixtures exercise the native filesystem adapter and its error mapping.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import { it } from "@effect/vitest";
import { beforeEach, expect, vi } from "vite-plus/test";

import { physicalCleanupFileSystem } from "./physicalCleanupFileSystem.ts";

const runtime = vi.hoisted(() => ({ electron: true }));
vi.mock("@t3tools/shared/nativeFileSystem", async (original) => ({
  ...(await original<typeof import("@t3tools/shared/nativeFileSystem")>()),
  get isElectron() {
    return runtime.electron;
  },
}));
beforeEach(() => {
  runtime.electron = true;
});

const fixture = async () => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "physical-cleanup-")),
  );
  return {
    root,
    fs: physicalCleanupFileSystem(FileSystem.makeNoop({})),
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
};

it.effect("inspects and removes physical archive files, directories and symlinks", () =>
  Effect.gen(function* () {
    const test = yield* Effect.acquireDisposable(Effect.promise(fixture));
    const file = NodePath.join(test.root, "archive.asar");
    const directory = NodePath.join(test.root, "directory.asar");
    const link = NodePath.join(test.root, "link.asar");
    yield* test.fs.writeFileString(file, "raw archive bytes");
    yield* test.fs.makeDirectory(directory);
    yield* Effect.promise(() => NodeFSP.symlink("archive.asar", link));
    const info = yield* test.fs.stat(file);
    const native = yield* Effect.promise(() => NodeFSP.stat(file, { bigint: true }));
    expect(info.type).toBe("File");
    expect(info.size).toBe(native.size);
    expect(Option.getOrThrow(info.ino)).toBe(native.ino);
    expect(info.dev).toBe(native.dev);
    expect(info.mode).toBe(Number(native.mode));
    expect(yield* test.fs.readFileString(file)).toBe("raw archive bytes");
    expect(yield* test.fs.exists(file)).toBe(true);
    expect(yield* test.fs.realPath(link)).toBe(file);
    expect(yield* test.fs.readLink(link)).toBe("archive.asar");
    expect((yield* test.fs.stat(directory)).type).toBe("Directory");
    expect(yield* test.fs.readDirectory(test.root)).toEqual(
      expect.arrayContaining(["archive.asar", "directory.asar", "link.asar"]),
    );
    const renamed = NodePath.join(directory, "moved.asar");
    yield* test.fs.rename(file, renamed);
    yield* test.fs.writeFileString(renamed, " appended", { flag: "a" });
    expect(yield* test.fs.readFileString(renamed)).toBe("raw archive bytes appended");
    yield* test.fs.remove(directory, { recursive: true });
    expect(yield* test.fs.exists(directory)).toBe(false);
    expect(yield* test.fs.exists(link)).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("keeps native failures in the FileSystem error channel", () =>
  Effect.gen(function* () {
    const test = yield* Effect.acquireDisposable(Effect.promise(fixture));
    const absent = NodePath.join(test.root, "absent.asar");
    for (const method of ["stat", "realPath", "readFileString"] as const) {
      const operation: Effect.Effect<string | FileSystem.File.Info, PlatformError.PlatformError> =
        test.fs[method](absent);
      const error = yield* Effect.flip(Effect.asVoid(operation));
      expect(error.reason).toMatchObject({ _tag: "NotFound", module: "FileSystem" });
      expect(error.reason.cause).toMatchObject({ code: "ENOENT" });
    }
    const error = yield* Effect.flip(Effect.asVoid(test.fs.readFileString(test.root)));
    expect(error.reason).toMatchObject({ _tag: "BadResource", module: "FileSystem" });
  }).pipe(Effect.scoped),
);

it.effect("retains the supplied filesystem outside Electron", () =>
  Effect.gen(function* () {
    runtime.electron = false;
    const provided = FileSystem.makeNoop({ exists: () => Effect.succeed(true) });
    const fs = physicalCleanupFileSystem(provided);
    expect(yield* fs.exists("/injected-only")).toBe(true);
  }).pipe(Effect.scoped),
);
