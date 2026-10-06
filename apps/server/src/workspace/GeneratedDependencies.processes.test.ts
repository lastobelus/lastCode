import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import type * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import { afterEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as GeneratedDependencies from "./GeneratedDependencies.ts";

vi.mock("node:fs/promises", () => ({ readdir: vi.fn(), stat: vi.fn(), readlink: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const inventory = (platform: NodeJS.Platform, uid: number | undefined) =>
  GeneratedDependencies.ProcessWorkingDirectories.defaultValue().pipe(
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(HostProcessUserId, uid),
  );

it.effect("does not authorize deletion when platform or process ownership is unavailable", () =>
  Effect.gen(function* () {
    expect(yield* inventory("win32", 42)).toBeNull();
    expect(yield* inventory("linux", undefined)).toBeNull();
  }),
);

it.effect("reads Linux same-user cwd paths without reading other users' processes", () =>
  Effect.gen(function* () {
    vi.mocked(NodeFSP.readdir).mockResolvedValue(["10", "20", "self"] as never);
    vi.mocked(NodeFSP.stat).mockImplementation(
      async (path) => ({ uid: path === "/proc/10" ? 42 : 7 }) as NodeFS.Stats,
    );
    vi.mocked(NodeFSP.readlink).mockResolvedValue("/worktrees/feature");
    expect(yield* inventory("linux", 42)).toEqual(["/worktrees/feature"]);
    expect(NodeFSP.readlink).toHaveBeenCalledTimes(1);
  }),
);

it.effect("allows a vanished Linux process but preserves on unreadable process cwd", () =>
  Effect.gen(function* () {
    vi.mocked(NodeFSP.readdir).mockResolvedValue(["10", "20"] as never);
    vi.mocked(NodeFSP.stat).mockResolvedValue({ uid: 42 } as NodeFS.Stats);
    vi.mocked(NodeFSP.readlink)
      .mockResolvedValueOnce("/worktrees/feature")
      .mockRejectedValueOnce({ code: "ENOENT" });
    expect(yield* inventory("linux", 42)).toEqual(["/worktrees/feature"]);
    vi.mocked(NodeFSP.readlink).mockRejectedValue({ code: "EACCES" });
    expect(yield* inventory("linux", 42)).toBeNull();
  }),
);

it.effect("fails closed on unavailable Linux process inventory", () =>
  Effect.gen(function* () {
    vi.mocked(NodeFSP.readdir).mockRejectedValue({ code: "EACCES" });
    expect(yield* inventory("linux", 42)).toBeNull();
  }),
);

const mockLsof = (stdout: string, stderr = "", error: Error | null = null) => {
  vi.mocked(NodeChildProcess.execFile).mockImplementation((_file, _args, _options, callback) => {
    (callback as (error: Error | null, stdout: string, stderr: string) => void)(
      error,
      stdout,
      stderr,
    );
    return {} as NodeChildProcess.ChildProcess;
  });
};

it.effect("reads null-delimited macOS cwd fields, including paths with newlines", () =>
  Effect.gen(function* () {
    mockLsof("p10\0\nfcwd\0n/worktrees/feature\0\np20\0\nfcwd\0n/worktrees/other\nnotes\0\n");
    expect(yield* inventory("darwin", 42)).toEqual([
      "/worktrees/feature",
      "/worktrees/other\nnotes",
    ]);
    expect(NodeChildProcess.execFile).toHaveBeenCalledWith(
      "lsof",
      expect.arrayContaining(["-u", "42", "-d", "cwd"]),
      expect.objectContaining({ timeout: 10_000, maxBuffer: 1024 * 1024 }),
      expect.any(Function),
    );
  }),
);

it.effect("preserves workspaces on failed, truncated, warned or incomplete macOS inventory", () =>
  Effect.gen(function* () {
    mockLsof("", "", new Error("maxBuffer exceeded"));
    expect(yield* inventory("darwin", 42)).toBeNull();
    mockLsof("p10\0n/worktrees/feature\0", "unreadable process");
    expect(yield* inventory("darwin", 42)).toBeNull();
    mockLsof("p10\0n/worktrees/feature\0p20\0");
    expect(yield* inventory("darwin", 42)).toBeNull();
  }),
);
