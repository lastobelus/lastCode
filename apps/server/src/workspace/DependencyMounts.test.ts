import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off - Mock the native mount-table boundary.
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { afterEach, describe, expect, vi } from "vite-plus/test";

import * as DependencyMounts from "./DependencyMounts.ts";

const native = vi.hoisted(() => ({
  open: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ open: native.open }));
vi.mock("node:child_process", () => ({ execFile: native.execFile }));

afterEach(() => vi.resetAllMocks());

const inventory = (platform: NodeJS.Platform) =>
  DependencyMounts.MountPoints.defaultValue().pipe(
    Effect.provideService(HostProcess.Platform, platform),
  );

const linuxRoot = "20 1 8:1 / / rw,relatime - ext4 /dev/root rw\n";
const linuxMount = (point: string) =>
  `21 20 8:1 /source ${point} rw shared:1 master:2 - ext4 /dev/root rw\n`;

const linuxTable = (table: string, fragmentBytes = Number.MAX_SAFE_INTEGER) => {
  const bytes = Buffer.from(table);
  let position = 0;
  const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
    const bytesRead = Math.min(length, fragmentBytes, bytes.length - position);
    bytes.copy(buffer, offset, position, position + bytesRead);
    position += bytesRead;
    return { bytesRead, buffer };
  });
  const close = vi.fn(async () => undefined);
  native.open.mockResolvedValue({ read, close });
  return { read, close, bytesRead: () => position };
};

const darwinTable = (stdout: string, stderr = "", error: Error | null = null) => {
  native.execFile.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: { timeout: number; maxBuffer: number },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(error, stdout, stderr),
  );
};
const darwinRoot = "/dev/disk1s1 on / (apfs, local, read-only, journaled)\n";

describe("Linux dependency mount inventory", () => {
  it.effect(
    "finds root and descendant bind mounts even when their device matches the root filesystem",
    () =>
      Effect.gen(function* () {
        linuxTable(
          linuxRoot +
            linuxMount("/workspace/node_modules") +
            linuxMount("/workspace/node_modules/cache/file"),
        );
        const points = yield* inventory("linux");
        expect(points).toEqual([
          "/",
          "/workspace/node_modules",
          "/workspace/node_modules/cache/file",
        ]);
        expect(DependencyMounts.containsMount("/workspace/node_modules", points!)).toBe(true);
        expect(DependencyMounts.containsMount("/workspace/node_modules/cache", points!)).toBe(true);
      }),
  );

  it.effect("decodes all kernel mountinfo path escapes across fragmented reads", () =>
    Effect.gen(function* () {
      const file = linuxTable(
        linuxRoot + linuxMount("/workspace/space\\040tab\\011line\\012slash\\134name"),
        7,
      );
      expect(yield* inventory("linux")).toEqual(["/", "/workspace/space tab\tline\nslash\\name"]);
      expect(file.read.mock.calls.length).toBeGreaterThan(2);
      expect(file.close).toHaveBeenCalledOnce();
      expect(native.open).toHaveBeenCalledWith("/proc/self/mountinfo", "r");
    }),
  );

  it.effect.each([
    ["empty", ""],
    ["missing root mount", linuxMount("/workspace/node_modules")],
    ["truncated record", linuxRoot + "21 20 8:1 /source /workspace/node_modules rw - ext4"],
    ["missing final newline", linuxRoot + linuxMount("/workspace/node_modules").trimEnd()],
    ["undecodable path", linuxRoot + linuxMount("/workspace/invalid\uFFFDname")],
    ["invalid mount id", linuxRoot + linuxMount("/workspace/node_modules").replace("21 ", "id ")],
    ["invalid device", linuxRoot + linuxMount("/workspace/node_modules").replace("8:1", "device")],
    ["relative mountpoint", linuxRoot + linuxMount("workspace/node_modules")],
    ["unsupported escape", linuxRoot + linuxMount("/workspace/bad\\041name")],
    [
      "relative filesystem root",
      linuxRoot + linuxMount("/workspace/node_modules").replace("/source", "source"),
    ],
    [
      "empty mount options",
      linuxRoot + linuxMount("/workspace/node_modules").replace(" rw shared:1", "  shared:1"),
    ],
    [
      "empty filesystem type",
      linuxRoot + linuxMount("/workspace/node_modules").replace("- ext4", "- "),
    ],
  ] as const)("fails closed for %s", ([_name, table]) =>
    Effect.gen(function* () {
      const file = linuxTable(table, 11);
      expect(yield* inventory("linux")).toBeNull();
      expect(file.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("fails closed when mountinfo cannot be opened", () =>
    Effect.gen(function* () {
      native.open.mockRejectedValue(new Error("access denied"));
      expect(yield* inventory("linux")).toBeNull();
    }),
  );

  it.effect("closes the file and fails closed after a read error", () =>
    Effect.gen(function* () {
      const file = linuxTable(linuxRoot);
      file.read.mockRejectedValueOnce(new Error("read failed"));
      expect(yield* inventory("linux")).toBeNull();
      expect(file.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("fails closed if closing the mount inventory fails", () =>
    Effect.gen(function* () {
      const file = linuxTable(linuxRoot);
      file.close.mockRejectedValueOnce(new Error("close failed"));
      expect(yield* inventory("linux")).toBeNull();
    }),
  );

  it.effect("bounds fragmented reads and fails closed for an inventory larger than 1 MiB", () =>
    Effect.gen(function* () {
      const file = linuxTable(linuxRoot + linuxMount("/" + "x".repeat(1024 * 1024)), 4096);
      expect(yield* inventory("linux")).toBeNull();
      expect(file.bytesRead()).toBe(1024 * 1024 + 1);
      expect(file.close).toHaveBeenCalledOnce();
    }),
  );
});

describe("Darwin dependency mount inventory", () => {
  it.effect("preserves raw spaces in mount sources and root or nested mountpoints", () =>
    Effect.gen(function* () {
      darwinTable(
        darwinRoot +
          "volume name on /workspace/node_modules (apfs, local)\n" +
          "nested volume on /workspace/node_modules/package cache (apfs, local, journaled)\n",
      );
      expect(yield* inventory("darwin")).toEqual([
        "/",
        "/workspace/node_modules",
        "/workspace/node_modules/package cache",
      ]);
      expect(native.execFile).toHaveBeenCalledWith(
        "/sbin/mount",
        [],
        { timeout: 10_000, maxBuffer: 1024 * 1024 },
        expect.any(Function),
      );
    }),
  );

  it.effect.each([
    ["empty", ""],
    ["missing root", "disk on /workspace/node_modules (apfs, local)\n"],
    ["malformed", darwinRoot + "unparseable mount record\n"],
    ["truncated", darwinRoot + "disk on /workspace/node_modules (apfs"],
    ["missing final newline", darwinRoot.trimEnd()],
    ["undecodable path", darwinRoot + "disk on /workspace/invalid\uFFFDname (apfs)\n"],
    [
      "ambiguous source delimiter",
      darwinRoot + "volume on source on /workspace/node_modules (apfs)\n",
    ],
    ["ambiguous mountpoint delimiter", darwinRoot + "disk on /workspace/on on modules (apfs)\n"],
    ["ambiguous options delimiter", darwinRoot + "disk on /workspace/node_modules (cache (apfs)\n"],
    ["newline in source", darwinRoot + "volume\nname on /workspace/node_modules (apfs)\n"],
    ["newline in mountpoint", darwinRoot + "disk on /workspace/node_modules/line\nbreak (apfs)\n"],
  ] as const)("fails closed for %s", ([_name, table]) =>
    Effect.gen(function* () {
      darwinTable(table);
      expect(yield* inventory("darwin")).toBeNull();
    }),
  );

  it.effect("fails closed on mount warnings even with otherwise valid output", () =>
    Effect.gen(function* () {
      darwinTable(darwinRoot, "mount: partial inventory\n");
      expect(yield* inventory("darwin")).toBeNull();
    }),
  );

  it.effect.each([
    new Error("mount failed"),
    Object.assign(new Error("stdout maxBuffer length exceeded"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    }),
  ])("fails closed on command errors including maxBuffer exhaustion", (error) =>
    Effect.gen(function* () {
      darwinTable(darwinRoot, "", error);
      expect(yield* inventory("darwin")).toBeNull();
    }),
  );
});

it.effect("fails closed on unsupported platforms without running a mount command", () =>
  Effect.gen(function* () {
    expect(yield* inventory("win32")).toBeNull();
    expect(native.open).not.toHaveBeenCalled();
    expect(native.execFile).not.toHaveBeenCalled();
  }),
);

it("matches a mounted file or directory at or beneath the candidate, excluding ancestors and siblings", () => {
  const root = "/workspace/node_modules";
  expect(DependencyMounts.containsMount(root, [root])).toBe(true);
  expect(DependencyMounts.containsMount(root, [`${root}/cache/file`])).toBe(true);
  expect(
    DependencyMounts.containsMount(root, [
      "/",
      "/workspace",
      `${root}-sibling`,
      "/workspace/other/file",
    ]),
  ).toBe(false);
});
