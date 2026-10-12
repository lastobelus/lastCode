import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { beforeEach, describe, expect, vi } from "vite-plus/test";

import * as DependencyMounts from "./DependencyMounts.ts";
import * as WorktreeConsumers from "./WorktreeConsumers.ts";

const native = vi.hoisted(() => ({
  open: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
  readdir: vi.fn(),
  readlink: vi.fn(),
  realpath: vi.fn(),
  readFile: vi.fn(),
  execFile: vi.fn(),
  isProcessAlive: vi.fn(),
}));
vi.mock("node:fs/promises", () => native);
vi.mock("node:child_process", () => ({ execFile: native.execFile }));
vi.mock("../serverRuntimeState.ts", async (original) => ({
  ...(await original<typeof import("../serverRuntimeState.ts")>()),
  isProcessAlive: native.isProcessAlive,
}));

const missing = () => Object.assign(new Error("absent"), { code: "ENOENT" });
beforeEach(() => {
  vi.resetAllMocks();
  native.lstat.mockRejectedValue(missing());
  native.realpath.mockImplementation(async (path: string) => path);
});

const inventory = (platform: NodeJS.Platform) =>
  WorktreeConsumers.ProcessPaths.defaultValue().pipe(
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.UserId, 1000),
  );
const guard = (paths: ReadonlyArray<string> | null, mounts: ReadonlyArray<string> | null = ["/"]) =>
  WorktreeConsumers.worktreeConsumerReason("/workspace/example").pipe(
    Effect.provideService(WorktreeConsumers.ProcessPaths, Effect.succeed(paths)),
    Effect.provideService(DependencyMounts.MountPoints, Effect.succeed(mounts)),
  );

const maps =
  "1000-2000 r-xp 00000000 08:01 12 /workspace/example/apps/server/dist/bin.mjs (deleted)\n" +
  "2000-3000 rw-p 00000000 00:00 0 [heap]\n";
const linuxFixture = (table = maps) => {
  native.readdir.mockImplementation(async (path: string) => {
    if (path === "/proc") return ["self", "10", "20"];
    if (path === "/proc/10/fd") return ["1", "2", "3"];
    throw missing();
  });
  native.stat.mockImplementation(async (path: string) => ({
    uid: path === "/proc/10" ? 1000 : 2000,
  }));
  native.readlink.mockImplementation(
    async (path: string) =>
      ({
        "/proc/10/cwd": "/workspace/elsewhere",
        "/proc/10/exe": "/workspace/example/native/resource-monitor/target/debug/monitor",
        "/proc/10/fd/1": "/workspace/example/apps/web/dist/index.html",
        "/proc/10/fd/2": "socket:[123]",
        "/proc/10/fd/3": "anon_inode:[eventpoll]",
      })[path],
  );
  const bytes = Buffer.from(table);
  let position = 0;
  const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
    const bytesRead = Math.min(length, 19, bytes.length - position);
    bytes.copy(buffer, offset, position, position + bytesRead);
    position += bytesRead;
    return { bytesRead };
  });
  const close = vi.fn(async () => undefined);
  native.open.mockResolvedValue({ read, close });
  return { close, read };
};

describe("Linux worktree consumers", () => {
  it.effect(
    "finds executable, open and mapped files when cwd is elsewhere, skipping another UID",
    () =>
      Effect.gen(function* () {
        const file = linuxFixture();
        const paths = yield* inventory("linux");
        expect(paths).toEqual([
          "/workspace/elsewhere",
          "/workspace/example/native/resource-monitor/target/debug/monitor",
          "/workspace/example/apps/web/dist/index.html",
          "/workspace/example/apps/server/dist/bin.mjs",
        ]);
        expect(yield* guard(paths)).toBe("A process is using a file or directory in the worktree.");
        expect(file.close).toHaveBeenCalledOnce();
        expect(native.readlink).not.toHaveBeenCalledWith("/proc/20/cwd");
      }),
  );

  it.effect.each([
    "invalid mapping\n",
    maps.trimEnd(),
    "1000-2000 r-xp 00000000 08:01 12 relative/output\n",
    "1000-2000 r-xp 00000000 08:01 12 /invalid\uFFFDname\n",
    "1000-2000 r-xp 00000000 08:01 12 /escaped\\012name\n",
  ])("keeps incomplete or undecodable mapping evidence", (table) =>
    Effect.gen(function* () {
      const file = linuxFixture(table);
      expect(yield* inventory("linux")).toBeNull();
      expect(file.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("keeps when required process evidence is missing but the process still exists", () =>
    Effect.gen(function* () {
      linuxFixture();
      native.readlink.mockRejectedValue(missing());
      expect(yield* inventory("linux")).toBeNull();
    }),
  );

  it.effect("tolerates a vanished process and an fd closed during observation", () =>
    Effect.gen(function* () {
      linuxFixture();
      native.readdir.mockImplementation(async (path: string) =>
        path === "/proc" ? ["9", "10"] : ["1"],
      );
      native.stat.mockImplementation(async (path: string) => {
        if (path === "/proc/9") throw missing();
        return { uid: 1000 };
      });
      native.readlink.mockImplementation(async (path: string) => {
        if (path.endsWith("/1")) throw missing();
        return "/workspace/elsewhere";
      });
      expect(yield* inventory("linux")).toEqual([
        "/workspace/elsewhere",
        "/workspace/elsewhere",
        "/workspace/example/apps/server/dist/bin.mjs",
      ]);
    }),
  );

  it.effect("fails closed on permission errors", () =>
    Effect.gen(function* () {
      linuxFixture();
      native.readlink.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
      expect(yield* inventory("linux")).toBeNull();
    }),
  );
});

const lsof =
  "p10\0\nfcwd\0tDIR\0n/workspace/elsewhere\0\n" +
  "ftxt\0tREG\0n/workspace/example/native/resource-monitor/target/debug/monitor\0\n" +
  "f4\0tREG\0n/workspace/example/apps/web/dist/file with spaces.js (deleted)\0\n" +
  "f5\0tIPv4\0n127.0.0.1:1234\0\n";
const darwinFixture = (output = lsof, stderr = "", error: Error | null = null) => {
  native.execFile.mockImplementation((_file, _args, _options, callback) =>
    callback(error, output, stderr),
  );
};
describe("Darwin worktree consumers", () => {
  it.effect("reads every cwd, text and open path rather than a cwd-only selection", () =>
    Effect.gen(function* () {
      darwinFixture();
      expect(yield* inventory("darwin")).toEqual([
        "/workspace/elsewhere",
        "/workspace/example/native/resource-monitor/target/debug/monitor",
        "/workspace/example/apps/web/dist/file with spaces.js",
      ]);
      expect(native.execFile).toHaveBeenCalledWith(
        "lsof",
        ["-a", "-u", "1000", "-F0pftn", "-n", "-P"],
        { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
        expect.any(Function),
      );
    }),
  );
  it.effect.each([
    "",
    lsof.slice(0, -2),
    lsof.replace("fcwd", "f3"),
    lsof.replace("tREG", ""),
    lsof.replace("n/workspace/elsewhere", "nrelative"),
    lsof + "p20\0\nftxt\0tREG\0n/bin/tool\0\n",
    lsof.replace("file with spaces.js", "file\\nname.js"),
    lsof.replace("file with spaces.js", "file\uFFFDname.js"),
  ])("keeps malformed or partial lsof output", (output) =>
    Effect.gen(function* () {
      darwinFixture(output);
      expect(yield* inventory("darwin")).toBeNull();
    }),
  );
  it.effect("keeps when lsof reports warnings despite valid output", () =>
    Effect.gen(function* () {
      darwinFixture(lsof, "partial inventory");
      expect(yield* inventory("darwin")).toBeNull();
    }),
  );
  it.effect(
    "accepts normal non-file socket and kernel descriptors without inventing filesystem paths",
    () =>
      Effect.gen(function* () {
        darwinFixture(
          lsof +
            "f6\0tunix\0n->0x12345\0\nf7\0tKQUEUE\0\n" +
            "p20\0\nfcwd\0tDIR\0n/workspace/other\0\nf1\0tunix\0n/var/run/example.sock\0\n",
        );
        expect(yield* inventory("darwin")).toEqual([
          "/workspace/elsewhere",
          "/workspace/example/native/resource-monitor/target/debug/monitor",
          "/workspace/example/apps/web/dist/file with spaces.js",
          "/workspace/other",
          "/var/run/example.sock",
        ]);
      }),
  );
});

describe("worktree removal guard", () => {
  it.effect("fails closed for unsupported hosts and missing process or mount inventories", () =>
    Effect.gen(function* () {
      expect(yield* inventory("win32")).toBeNull();
      expect(yield* guard(null)).toBe("Process file-consumer inventory is unavailable.");
      expect(yield* guard([], null)).toBe("Mount inventory is unavailable.");
      expect(native.execFile).not.toHaveBeenCalled();
    }),
  );
  it.effect("protects nested mounts, excludes sibling names, and resolves consumer aliases", () =>
    Effect.gen(function* () {
      expect(yield* guard([], ["/", "/workspace/example"])).toBe(
        "A mounted path is inside the worktree.",
      );
      expect(yield* guard([], ["/", "/workspace/example/target/cache"])).toBe(
        "A mounted path is inside the worktree.",
      );
      expect(yield* guard(["/workspace/example-sibling/dist/file"])).toBeNull();
      native.realpath.mockImplementation(async (path: string) =>
        path === "/alias/file" ? "/workspace/example/dist/file" : path,
      );
      expect(yield* guard(["/alias/file"])).toBe(
        "A process is using a file or directory in the worktree.",
      );
    }),
  );
  it.effect(
    "keeps active, unreadable, and linked runtime state, allowing a valid stopped descriptor",
    () =>
      Effect.gen(function* () {
        native.lstat.mockImplementation(async (path: string) => ({
          isDirectory: () => !path.endsWith(".json"),
          isFile: () => path.endsWith(".json"),
          size: 128,
        }));
        native.readFile.mockResolvedValue(
          JSON.stringify({
            version: 1,
            pid: 42,
            port: 1234,
            origin: "http://workstation.example",
            startedAt: "2026-01-01T00:00:00Z",
          }),
        );
        native.isProcessAlive.mockReturnValue(true);
        expect(yield* guard([])).toBe("A server runtime is still active.");
        native.isProcessAlive.mockReturnValue(false);
        expect(yield* guard([])).toBeNull();
        native.readFile.mockResolvedValue("invalid");
        expect(yield* guard([])).toBe("Runtime descriptor cannot be safely read.");
        native.lstat.mockResolvedValue({ isDirectory: () => false });
        expect(yield* guard([])).toBe("Runtime state path is not a regular directory.");
      }),
  );
  it.effect("keeps canonicalization and runtime read failures", () =>
    Effect.gen(function* () {
      native.realpath.mockResolvedValue("/workspace/other");
      expect(yield* guard([])).toBe("Worktree root is not canonical.");
      native.realpath.mockImplementation(async (path: string) => path);
      native.lstat.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
      expect(yield* guard([])).toBe("Worktree consumer protection could not be verified.");
    }),
  );
  it.effect(
    "keeps a consumer alias that cannot be resolved due to permission rather than silently skipping it",
    () =>
      Effect.gen(function* () {
        native.realpath.mockImplementation(async (path: string) => {
          if (path === "/alias/file") throw Object.assign(new Error("denied"), { code: "EACCES" });
          return path;
        });
        expect(yield* guard(["/alias/file"])).toBe(
          "Worktree consumer protection could not be verified.",
        );
      }),
  );
});
