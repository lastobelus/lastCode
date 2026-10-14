import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { beforeEach, describe, expect, vi } from "vite-plus/test";

import * as DependencyMounts from "./DependencyMounts.ts";
import * as WorktreeConsumers from "./WorktreeConsumers.ts";

const native = vi.hoisted(() => ({
  open: vi.fn(),
  opendir: vi.fn(),
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
  native.open.mockImplementation(async () => {
    position = 0;
    return { read, close };
  });
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
      expect(file.close).toHaveBeenCalledTimes(2);
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
        ["-a", "-u", "1000", "-F0pftnDi", "-n", "-P"],
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
  it.effect.each([
    ["unicode-\\xc3\\xa9.txt", "unicode-é.txt"],
    ["unicode-\\xf0\\x9f\\x98\\x80.txt", "unicode-😀.txt"],
    ["literal-\\\\xc3\\\\xa9.txt", "literal-\\xc3\\xa9.txt"],
    ["newline-\\nnote.txt", "newline-\nnote.txt"],
    ["literal-\\\\nnote.txt", "literal-\\nnote.txt"],
    ["mixed-\\\\x41-\\xc3\\xa9.txt", "mixed-\\x41-é.txt"],
    ["raw-é-😀.txt", "raw-é-😀.txt"],
    ["controls-\\b\\f\\r\\t.txt", "controls-\b\f\r\t.txt"],
    ["ordinary-^lower.txt", "ordinary-^lower.txt"],
  ] as const)("decodes an emitted pathname once (%s)", ([printed, actual]) =>
    Effect.gen(function* () {
      const name = `/workspace/example/${printed}`;
      darwinFixture(`p123\0\nfcwd\0tDIR\0n/workspace/elsewhere\0\nf4\0tREG\0n${name}\0\n`);
      const paths = yield* inventory("darwin");
      expect(paths).toEqual(["/workspace/elsewhere", `/workspace/example/${actual}`]);
      expect(yield* guard(paths)).toBe("A process is using a file or directory in the worktree.");
    }),
  );
  it.effect.each(["cwd", "txt", "4"] as const)(
    "decoded %s pathname evidence protects its canonical worktree root",
    (descriptor) =>
      Effect.gen(function* () {
        const actualRoot = "/workspace/example/unicode-é";
        const actual = descriptor === "cwd" ? actualRoot : `${actualRoot}/file\nnote.txt`;
        const printed =
          descriptor === "cwd"
            ? "/workspace/example/unicode-\\xc3\\xa9"
            : "/workspace/example/unicode-\\xc3\\xa9/file\\nnote.txt";
        const prefix =
          descriptor === "cwd" ? "p123\0\n" : "p123\0\nfcwd\0tDIR\0n/workspace/elsewhere\0\n";
        darwinFixture(
          `${prefix}f${descriptor}\0t${descriptor === "cwd" ? "DIR" : "REG"}\0n${printed}\0\n`,
        );
        const paths = yield* inventory("darwin");
        expect(paths).toContain(actual);
        expect(
          yield* WorktreeConsumers.worktreeConsumerReason(actualRoot).pipe(
            Effect.provideService(WorktreeConsumers.ProcessPaths, Effect.succeed(paths)),
            Effect.provideService(DependencyMounts.MountPoints, Effect.succeed(["/"])),
          ),
        ).toBe("A process is using a file or directory in the worktree.");
      }),
  );
  it.effect.each([
    "trailing-\\",
    "short-\\x",
    "short-\\x0",
    "nonhex-\\xgg",
    "unknown-\\q",
    "overlong-\\xc0\\xaf",
    "truncated-\\xc3",
    "invalid-\\xc3\\x28",
    "surrogate-\\xed\\xa0\\x80",
    "too-high-\\xf4\\x90\\x80\\x80",
    "nul-\\x00",
    "caret-^A",
    "caret-^?",
    "raw-line\nbreak",
    "raw-tab\tname",
    "raw-\uD800name",
  ])("keeps malformed, invalid UTF-8 or ambiguous pathname evidence (%s)", (name) =>
    Effect.gen(function* () {
      darwinFixture(`p123\0\nfcwd\0tDIR\0n/workspace\0\nf4\0tREG\0n/workspace/${name}\0\n`);
      expect(yield* inventory("darwin")).toBeNull();
    }),
  );
  it.effect.each(["NPOLICY", "CHAN", "NEXUS"] as const)(
    "accepts anonymous %s descriptors without inventing filesystem paths",
    (type) =>
      Effect.gen(function* () {
        darwinFixture(lsof + `f10\0t${type}\0n0x12345678\0\nf11\0t${type}\0\n`);
        expect(yield* inventory("darwin")).toEqual([
          "/workspace/elsewhere",
          "/workspace/example/native/resource-monitor/target/debug/monitor",
          "/workspace/example/apps/web/dist/file with spaces.js",
        ]);
      }),
  );
  it.effect(
    "accepts the exact numeric ENOENT no-current-path marker without treating unknown descriptors as safe",
    () =>
      Effect.gen(function* () {
        darwinFixture("p123\0\nfcwd\0tDIR\0n/workspace\0\nf0\0n(revoked)\0\nf17\0n(revoked)\0\n");
        expect(yield* inventory("darwin")).toEqual(["/workspace"]);
      }),
  );
  it.effect.each([
    "f0\0nrelative/file\0\n",
    "f0\0n/workspace/file\0\n",
    "f0\0\n",
    "f0\0n(revoked) \0\n",
    "f0u\0n(revoked)\0\n",
    "ftxt\0n(revoked)\0\n",
    "fcwd\0n(revoked)\0\n",
    "ffp.17\0n(revoked)\0\n",
    "f0\0n(proc_pidfdinfo error)\0\n",
    "f0\0t\0n(revoked)\0\n",
    "f1\0tUNKNOWN\0n0x1234\0\n",
    "f1\0tREG\0n0x1234\0\n",
    "fcwd\0tNPOLICY\0n0x1234\0\n",
    "ftxt\0tNEXUS\0n0x1234\0\n",
  ])(
    "keeps missing or unknown file evidence that does not match an explicit revoked descriptor",
    (record) =>
      Effect.gen(function* () {
        darwinFixture(lsof + record);
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
            "f8\0tPIPE\0n0xabcdef0123456789->0x123456789abcdef0\0\n" +
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

const vnodeFixture = (fields = "D0x12\0i9007199254740993\0", type = "REG", code = "EACCES") => {
  darwinFixture(
    "p123\0\nfcwd\0tDIR\0n/workspace/elsewhere\0\n" +
      `f4\0t${type}\0${fields}n/system/example/file\0\n`,
  );
  native.realpath.mockImplementation(async (path: string) => {
    if (path === "/system/example/file") throw Object.assign(new Error("denied"), { code });
    return path;
  });
};
const objectStat = (inode: bigint, directory = false, device = 18n, modified = 1n) => ({
  dev: device,
  ino: inode,
  mtimeNs: modified,
  ctimeNs: modified,
  isDirectory: () => directory,
  isSocket: () => false,
});
const targetFixture = (fileInode = 9007199254740993n) => {
  const stats = new Map([
    ["/workspace/example", objectStat(1n, true)],
    ["/workspace/example/dist", objectStat(2n, true)],
    ["/workspace/example/dist/output.js", objectStat(fileInode)],
    ["/workspace/example/link", objectStat(3n)],
  ]);
  native.lstat.mockImplementation(async (path: string) => {
    const stat = stats.get(path);
    if (!stat) throw missing();
    return stat;
  });
  native.opendir.mockImplementation(async (path: string) => {
    const names =
      path === "/workspace/example"
        ? ["dist", "link"]
        : path.endsWith("/dist")
          ? ["output.js"]
          : [];
    return (async function* () {
      for (const name of names) yield { name };
    })();
  });
  return stats;
};

const objectProofReason = "Process object identity or target inventory could not be verified.";

describe("Captured vnode identity proof", () => {
  it.effect("includes target directories in the device-unknown FIFO inode comparison", () =>
    Effect.gen(function* () {
      vnodeFixture("i2\0", "FIFO", "ENOENT");
      targetFixture();
      expect(yield* guard(yield* inventory("darwin"))).toBe(
        "A process is using a file or directory in the worktree.",
      );
    }),
  );
  it.effect.each([18n, 99n])(
    "protects an unlinked FIFO inode match regardless of device (%s)",
    (device) =>
      Effect.gen(function* () {
        vnodeFixture("i9007199254740993\0", "FIFO", "ENOENT");
        const stats = targetFixture();
        for (const [path, stat] of stats) stats.set(path, { ...stat, dev: device });
        expect(yield* guard(yield* inventory("darwin"))).toBe(
          "A process is using a file or directory in the worktree.",
        );
      }),
  );
  it.effect("proves an unlinked positive-inode FIFO absent from the complete target", () =>
    Effect.gen(function* () {
      vnodeFixture("i9007199254740993\0", "FIFO", "ENOENT");
      targetFixture(9007199254740992n);
      expect(yield* guard(yield* inventory("darwin"))).toBeNull();
      expect(native.opendir).toHaveBeenCalledWith("/workspace/example/dist");
    }),
  );
  it.effect.each(["", "i0\0"])(
    "keeps a vanished FIFO without positive native inode (%s)",
    (fields) =>
      Effect.gen(function* () {
        vnodeFixture(fields, "FIFO", "ENOENT");
        expect(yield* guard(yield* inventory("darwin"))).toBe(objectProofReason);
        expect(native.opendir).not.toHaveBeenCalled();
      }),
  );
  it.effect("keeps device-unknown FIFO permission evidence and nonnumeric descriptors", () =>
    Effect.gen(function* () {
      vnodeFixture("i123\0", "FIFO", "EACCES");
      expect(yield* guard(yield* inventory("darwin"))).toBe(objectProofReason);
      vnodeFixture("i123\0", "FIFO", "ENOENT");
      darwinFixture(
        "p123\0\nfcwd\0tDIR\0n/workspace/elsewhere\0\nftxt\0tFIFO\0i123\0n/system/example/file\0\n",
      );
      expect(yield* guard(yield* inventory("darwin"))).toBe(objectProofReason);
    }),
  );
  it.effect.each(["EACCES", "EPERM"])(
    "protects an unresolved %s open file by exact bigint identity",
    (code) =>
      Effect.gen(function* () {
        vnodeFixture(undefined, undefined, code);
        targetFixture();
        const paths = yield* inventory("darwin");
        expect(paths).toEqual(["/workspace/elsewhere", "/system/example/file"]);
        expect(yield* guard(paths)).toBe("A process is using a file or directory in the worktree.");
        expect(native.lstat).toHaveBeenCalledWith("/workspace/example/dist/output.js", {
          bigint: true,
        });
        expect(native.opendir).not.toHaveBeenCalledWith("/workspace/example/link");
      }),
  );
  it.effect("protects directory objects even when the observed cwd name is elsewhere", () =>
    Effect.gen(function* () {
      vnodeFixture("D0x12\0i2\0", "DIR");
      targetFixture();
      expect(yield* guard(yield* inventory("darwin"))).toBe(
        "A process is using a file or directory in the worktree.",
      );
    }),
  );
  it.effect.each(["EACCES", "EPERM"])(
    "proves an inaccessible %s external object absent only after a complete stable inventory",
    (code) =>
      Effect.gen(function* () {
        vnodeFixture(undefined, undefined, code);
        targetFixture(9007199254740992n);
        expect(yield* guard(yield* inventory("darwin"))).toBeNull();
        expect(native.opendir).toHaveBeenCalledWith("/workspace/example/dist");
      }),
  );
  it.effect("a lazy cached observation retains its native array and device/inode proof", () =>
    Effect.gen(function* () {
      vnodeFixture();
      targetFixture(9007199254740992n);
      const capture = yield* Effect.cached(inventory("darwin"));
      const original = yield* capture;
      const shared = yield* capture;
      expect(shared).toBe(original);
      expect(yield* guard(shared)).toBeNull();
      targetFixture();
      expect(yield* guard(shared)).toBe("A process is using a file or directory in the worktree.");
      expect(native.execFile).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect("does not equate accessible external hardlinks with use of this checkout", () =>
    Effect.gen(function* () {
      vnodeFixture();
      native.realpath.mockImplementation(async (path: string) => path);
      expect(yield* guard(yield* inventory("darwin"))).toBeNull();
      expect(native.opendir).not.toHaveBeenCalled();
    }),
  );
  it.effect.each(["", "D0x12\0", "i2\0", "D0x12\0i0\0"])(
    "keeps unresolved captured objects without usable complete identity (%s)",
    (fields) =>
      Effect.gen(function* () {
        vnodeFixture(fields);
        const paths = yield* inventory("darwin");
        expect(paths).not.toBeNull();
        expect(yield* guard(paths)).toBe(objectProofReason);
        expect(native.opendir).not.toHaveBeenCalled();
      }),
  );
  it.effect.each([
    "D\0i2\0",
    "D12\0i2\0",
    "D0xgg\0i2\0",
    "D0x12\0i\0",
    "D0x12\0i-2\0",
    "D0x12\0i2.0\0",
    "D0x12\0D0x12\0i2\0",
    "D0x12\0i2\0i2\0",
  ])("rejects malformed or duplicated captured identity fields (%s)", (fields) =>
    Effect.gen(function* () {
      vnodeFixture(fields);
      expect(yield* inventory("darwin")).toBeNull();
    }),
  );
  it.effect("keeps a target with a cross-device child, including a file", () =>
    Effect.gen(function* () {
      vnodeFixture();
      targetFixture().set("/workspace/example/dist/output.js", objectStat(8n, false, 19n));
      expect(yield* guard(yield* inventory("darwin"))).toBe(objectProofReason);
    }),
  );
  it.effect("keeps when a target directory changes during traversal", () =>
    Effect.gen(function* () {
      vnodeFixture();
      const stats = targetFixture();
      native.opendir.mockImplementation(async (path: string) =>
        (async function* () {
          if (path === "/workspace/example") {
            yield { name: "dist" };
            stats.set(path, objectStat(1n, true, 18n, 2n));
          } else yield { name: "output.js" };
        })(),
      );
      expect(yield* guard(yield* inventory("darwin"))).toBe(objectProofReason);
    }),
  );
  it.effect("keeps when traversal is incomplete despite a matching previously seen object", () =>
    Effect.gen(function* () {
      vnodeFixture();
      targetFixture();
      native.opendir.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
      expect(yield* guard(yield* inventory("darwin"))).toBe(objectProofReason);
    }),
  );
  it.effect("keeps when traversal exceeds the bounded depth", () =>
    Effect.gen(function* () {
      vnodeFixture();
      native.lstat.mockImplementation(async (path: string) =>
        objectStat(BigInt(path.length), true),
      );
      native.opendir.mockImplementation(async () =>
        (async function* () {
          yield { name: "nested" };
        })(),
      );
      expect(yield* guard(yield* inventory("darwin"))).toBe(objectProofReason);
    }),
  );
  it.effect.each(["EIO", "ELOOP", "ENOSYS", undefined])(
    "does not use native identity to bypass an unrelated resolution error (%s)",
    (code) =>
      Effect.gen(function* () {
        vnodeFixture();
        targetFixture();
        native.realpath.mockImplementation(async (path: string) => {
          if (path === "/system/example/file") throw Object.assign(new Error("unknown"), { code });
          return path;
        });
        expect(yield* guard(yield* inventory("darwin"))).toBe(
          "Worktree consumer protection could not be verified.",
        );
        expect(native.opendir).not.toHaveBeenCalled();
      }),
  );
  it.effect("retains fail-closed alias resolution for plain injected paths", () =>
    Effect.gen(function* () {
      vnodeFixture();
      targetFixture();
      expect(yield* guard(["/system/example/file"])).toBe(
        "Worktree consumer protection could not be verified.",
      );
      expect(native.opendir).not.toHaveBeenCalled();
    }),
  );
});

const socketFixture = (
  record = "f7\0tunix\0",
  code = "ENOENT",
  name = "/system/example/socket",
) => {
  darwinFixture(`p123\0\nfcwd\0tDIR\0n/workspace/elsewhere\0\n${record}n${name}\0\n`);
  native.realpath.mockImplementation(async (path: string) => {
    if (path === name) throw Object.assign(new Error("unresolved"), { code });
    return path;
  });
};

describe("Captured vanished Unix socket proof", () => {
  it.effect("accepts a vanished external socket only after a complete socket-free inventory", () =>
    Effect.gen(function* () {
      socketFixture();
      targetFixture();
      const paths = yield* inventory("darwin");
      expect(paths).toEqual(["/workspace/elsewhere", "/system/example/socket"]);
      expect(yield* guard(paths)).toBeNull();
      expect(native.opendir).toHaveBeenCalledWith("/workspace/example/dist");
      expect(native.opendir).not.toHaveBeenCalledWith("/workspace/example/link");
    }),
  );
  it.effect("protects any target socket even under a different name or hardlink", () =>
    Effect.gen(function* () {
      socketFixture();
      targetFixture().set("/workspace/example/dist/output.js", {
        ...objectStat(42n),
        isSocket: () => true,
      });
      expect(yield* guard(yield* inventory("darwin"))).toBe(
        "A process is using a file or directory in the worktree.",
      );
    }),
  );
  it.effect("keeps a cross-device target socket without using a device shortcut", () =>
    Effect.gen(function* () {
      socketFixture();
      targetFixture().set("/workspace/example/dist/output.js", {
        ...objectStat(42n, false, 99n),
        isSocket: () => true,
      });
      expect(yield* guard(yield* inventory("darwin"))).toBe(objectProofReason);
    }),
  );
  it.effect.each(["direct", "canonical"] as const)(
    "protects %s in-root socket evidence before attempting absence proof",
    (kind) =>
      Effect.gen(function* () {
        socketFixture(
          undefined,
          undefined,
          kind === "direct" ? "/workspace/example/socket" : undefined,
        );
        if (kind === "canonical")
          native.realpath.mockImplementation(async (path: string) =>
            path === "/system/example/socket" ? "/workspace/example/socket" : path,
          );
        expect(yield* guard(yield* inventory("darwin"))).toBe(
          "A process is using a file or directory in the worktree.",
        );
        expect(native.opendir).not.toHaveBeenCalled();
      }),
  );
  it.effect("keeps an incomplete target inventory for a vanished socket", () =>
    Effect.gen(function* () {
      socketFixture();
      targetFixture();
      native.opendir.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
      expect(yield* guard(yield* inventory("darwin"))).toBe(objectProofReason);
    }),
  );
  it.effect("keeps when the target changes while a socket-free inventory is being collected", () =>
    Effect.gen(function* () {
      socketFixture();
      const stats = targetFixture();
      native.opendir.mockImplementation(async (path: string) =>
        (async function* () {
          if (path === "/workspace/example") {
            yield { name: "dist" };
            stats.set(path, objectStat(1n, true, 18n, 2n));
          } else yield { name: "output.js" };
        })(),
      );
      expect(yield* guard(yield* inventory("darwin"))).toBe(objectProofReason);
    }),
  );
  it.effect.each([
    "f7\0tunix\0D0x12\0",
    "f7\0tunix\0i42\0",
    "f7\0tunix\0D0x12\0i42\0",
    "f7\0tREG\0",
    "f7\0tFIFO\0",
    "fcwd\0tunix\0",
    "ftxt\0tunix\0",
    "ffp.7\0tunix\0",
    "f7u\0tunix\0",
  ])(
    "keeps unresolved shapes outside the precise no-identity numeric Unix descriptor (%s)",
    (record) =>
      Effect.gen(function* () {
        socketFixture(record);
        targetFixture();
        expect(yield* guard(yield* inventory("darwin"))).toBe(objectProofReason);
        expect(native.opendir).not.toHaveBeenCalled();
      }),
  );
  it.effect.each(["EACCES", "EPERM", "ESRCH"])(
    "keeps Unix socket evidence for %s rather than treating it as a vanished name",
    (code) =>
      Effect.gen(function* () {
        socketFixture(undefined, code);
        targetFixture();
        expect(yield* guard(yield* inventory("darwin"))).toBe(objectProofReason);
        expect(native.opendir).not.toHaveBeenCalled();
      }),
  );
  it.effect.each([
    "f7\0tunix\0D\0n/system/example/socket\0\n",
    "f7\0tunix\0iinvalid\0n/system/example/socket\0\n",
    "f7\0tunix\0D0x12\0D0x12\0n/system/example/socket\0\n",
    "f7\0tunix\0n/system/example/socket-\\q\0\n",
  ])("never mints socket proof from malformed evidence (%s)", (record) =>
    Effect.gen(function* () {
      darwinFixture(`p123\0\nfcwd\0tDIR\0n/workspace/elsewhere\0\n${record}`);
      expect(yield* inventory("darwin")).toBeNull();
      expect(native.opendir).not.toHaveBeenCalled();
    }),
  );
  it.effect("does not grant socket class proof to injected paths", () =>
    Effect.gen(function* () {
      socketFixture();
      expect(yield* guard(["/system/example/socket"])).toBeNull();
      expect(native.opendir).not.toHaveBeenCalled();
      socketFixture(undefined, "EACCES");
      expect(yield* guard(["/system/example/socket"])).toBe(
        "Worktree consumer protection could not be verified.",
      );
    }),
  );
});

describe("Fresh native observation retry", () => {
  const incomplete =
    "p123\0\nfcwd\0tDIR\0n/workspace/elsewhere\0\n" +
    "f4\0tREG\0D0x12\0i42\0n/workspace/example/discarded.js\0\n" +
    "f7\0nunknown-current-path\0\n";

  it.effect(
    "discards the incomplete capture and retains only the second capture's native metadata",
    () =>
      Effect.gen(function* () {
        vnodeFixture();
        targetFixture();
        native.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
          callback(null, incomplete, ""),
        );
        const paths = yield* inventory("darwin");
        expect(paths).toEqual(["/workspace/elsewhere", "/system/example/file"]);
        expect(paths).not.toContain("/workspace/example/discarded.js");
        expect(yield* guard(paths)).toBe("A process is using a file or directory in the worktree.");
        expect(native.execFile).toHaveBeenCalledTimes(2);
      }),
  );
  it.effect("keeps a consumer that appears in the fresh retry", () =>
    Effect.gen(function* () {
      darwinFixture(
        "p123\0\nfcwd\0tDIR\0n/workspace/elsewhere\0\n" +
          "f8\0tREG\0n/workspace/example/dist/new-consumer.js\0\n",
      );
      native.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
        callback(null, incomplete, ""),
      );
      expect(yield* guard(yield* inventory("darwin"))).toBe(
        "A process is using a file or directory in the worktree.",
      );
      expect(native.execFile).toHaveBeenCalledTimes(2);
    }),
  );
  it.effect("does not retry a complete first capture", () =>
    Effect.gen(function* () {
      darwinFixture(lsof);
      expect(yield* inventory("darwin")).toEqual([
        "/workspace/elsewhere",
        "/workspace/example/native/resource-monitor/target/debug/monitor",
        "/workspace/example/apps/web/dist/file with spaces.js",
      ]);
      expect(native.execFile).toHaveBeenCalledOnce();
    }),
  );
  it.effect.each([incomplete, "unknown-frame\0\n"])(
    "keeps after a malformed first capture and an incomplete second (%s)",
    (second) =>
      Effect.gen(function* () {
        darwinFixture(second);
        native.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
          callback(null, incomplete, ""),
        );
        const paths = yield* inventory("darwin");
        expect(paths).toBeNull();
        expect(yield* guard(paths)).toBe("Process file-consumer inventory is unavailable.");
        expect(native.execFile).toHaveBeenCalledTimes(2);
      }),
  );
  it.effect.each(["error", "warning"] as const)(
    "discards a failed native %s capture even when its stdout looks complete",
    (failure) =>
      Effect.gen(function* () {
        const second = "p123\0\nfcwd\0tDIR\0n/workspace/elsewhere\0\n";
        darwinFixture(second);
        native.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
          callback(
            failure === "error"
              ? Object.assign(new Error("capture failed"), { code: "ETIMEDOUT" })
              : null,
            lsof,
            failure === "warning" ? "incomplete observation" : "",
          ),
        );
        expect(yield* inventory("darwin")).toEqual(["/workspace/elsewhere"]);
        expect(native.execFile).toHaveBeenCalledTimes(2);
      }),
  );
  it.effect("keeps after two failed native captures", () =>
    Effect.gen(function* () {
      darwinFixture(lsof, "", Object.assign(new Error("capture failed"), { code: "EACCES" }));
      expect(yield* inventory("darwin")).toBeNull();
      expect(native.execFile).toHaveBeenCalledTimes(2);
    }),
  );
  it.effect("retries a Linux native read failure with a new complete inventory", () =>
    Effect.gen(function* () {
      const file = linuxFixture();
      native.readdir.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
      const paths = yield* inventory("linux");
      expect(paths).toContain("/workspace/example/apps/web/dist/index.html");
      expect(yield* guard(paths)).toBe("A process is using a file or directory in the worktree.");
      expect(native.readdir.mock.calls.filter(([path]) => path === "/proc")).toHaveLength(2);
      expect(file.close).toHaveBeenCalledOnce();
    }),
  );
  it.effect("keeps after exactly two Linux native read failures", () =>
    Effect.gen(function* () {
      native.readdir.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
      expect(yield* inventory("linux")).toBeNull();
      expect(native.readdir).toHaveBeenCalledTimes(2);
    }),
  );
  it.effect("does not capture or retry when the native user identity is unavailable", () =>
    Effect.gen(function* () {
      expect(
        yield* WorktreeConsumers.ProcessPaths.defaultValue().pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(HostProcess.UserId, undefined),
        ),
      ).toBeNull();
      expect(native.execFile).not.toHaveBeenCalled();
      expect(native.readdir).not.toHaveBeenCalled();
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
