// @effect-diagnostics nodeBuiltinImport:off -- These real linked-worktree fixtures test the native filesystem and Git preservation boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";
import { expect, it, vi } from "vite-plus/test";

import { createWorktreeSuspensionStore } from "./worktreeSuspension.ts";
import { fixtureMetadataExecFile } from "./__fixtures__/worktree-suspension-metadata.ts";
import * as HostProcess from "./HostProcess.ts";

vi.mock("node:fs/promises", { spy: true });
vi.mock("node:child_process", { spy: true });

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const git = async (cwd: string, ...args: ReadonlyArray<string>) =>
  (await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd })).stdout.trim();

const fixture = async (normalizeMetadata = true) => {
  const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "worktree-suspension-"));
  const root = await NodeFSP.realpath(temporary);
  const repository = NodePath.join(root, "repository");
  const workspace = NodePath.join(root, "workspace");
  await NodeFSP.mkdir(repository);
  await git(repository, "init", "--initial-branch=main");
  await git(repository, "config", "user.email", "fixture@example.invalid");
  await git(repository, "config", "user.name", "Fixture");
  await NodeFSP.writeFile(NodePath.join(repository, "tracked.txt"), "base\n");
  await NodeFSP.writeFile(NodePath.join(repository, "deleted.txt"), "delete\n");
  await NodeFSP.writeFile(NodePath.join(repository, "staged-delete.txt"), "staged delete\n");
  await NodeFSP.writeFile(NodePath.join(repository, "binary"), Buffer.from([0, 255, 10, 0]));
  await NodeFSP.writeFile(NodePath.join(repository, ".gitignore"), "notes/\n");
  await NodeFSP.writeFile(
    NodePath.join(repository, ".gitattributes"),
    "filtered filter=sentinel\n",
  );
  await NodeFSP.writeFile(NodePath.join(repository, "filtered"), "BASE\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "fixture");
  await git(repository, "worktree", "add", "-b", "task", workspace, "HEAD");
  const head = await git(workspace, "rev-parse", "HEAD");
  await NodeFSP.writeFile(NodePath.join(workspace, "tracked.txt"), "staged\n");
  await git(workspace, "add", "tracked.txt");
  await NodeFSP.writeFile(NodePath.join(workspace, "tracked.txt"), "unstaged\n");
  await NodeFSP.unlink(NodePath.join(workspace, "deleted.txt"));
  await git(workspace, "rm", "staged-delete.txt");
  await NodeFSP.writeFile(NodePath.join(workspace, "staged-add"), "staged added\n");
  await git(workspace, "add", "staged-add");
  await NodeFSP.writeFile(NodePath.join(workspace, "staged-add"), "working added\n");
  await NodeFSP.mkdir(NodePath.join(workspace, "notes"));
  await NodeFSP.writeFile(NodePath.join(workspace, "notes", "private"), "ignored note\n");
  await NodeFSP.mkdir(NodePath.join(workspace, "empty"));
  await NodeFSP.symlink("../outside", NodePath.join(workspace, "link"));
  await NodeFSP.chmod(NodePath.join(workspace, "tracked.txt"), 0o751);
  await NodeFSP.writeFile(NodePath.join(workspace, "binary"), Buffer.from([255, 0, 12, 0, 42]));
  const sentinel = NodePath.join(root, "unexpected-execution");
  const hook = NodePath.join(repository, ".git", "hooks", "post-checkout");
  await NodeFSP.writeFile(hook, `#!/bin/sh\nprintf hook >> '${sentinel}'\n`);
  await NodeFSP.chmod(hook, 0o755);
  await git(
    repository,
    "config",
    "filter.sentinel.clean",
    `printf filter >> '${sentinel}'; printf 'BASE\\n'`,
  );
  await git(repository, "config", "filter.sentinel.smudge", `printf filter >> '${sentinel}'; cat`);
  await NodeFSP.writeFile(NodePath.join(workspace, "filtered"), "RAW DIFFERENT\n");
  const store = createWorktreeSuspensionStore({ storeRoot: NodePath.join(root, "saved") });
  const original = await vi.importActual<typeof NodeChildProcess>("node:child_process");
  const metadata = normalizeMetadata
    ? vi
        .spyOn(NodeChildProcess, "execFile")
        .mockImplementation(fixtureMetadataExecFile(root, original.execFile))
    : undefined;
  return {
    root,
    repository,
    workspace,
    head,
    sentinel,
    store,
    async [Symbol.asyncDispose]() {
      metadata?.mockRestore();
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
};

it.runIf(HostProcess.Platform.defaultValue() === "darwin")(
  "preserves hidden flags on actual Finder-style workspace entries",
  async () => {
    await using test = await fixture();
    await NodeFSP.writeFile(NodePath.join(test.workspace, ".DS_Store"), "finder data");
    const names = ["", "notes", ".DS_Store", "tracked.txt", "link"];
    for (const name of names)
      await execute("/usr/bin/chflags", ["-h", "hidden", NodePath.join(test.workspace, name)]);
    const snapshot = await test.store.capture({
      sourcePath: test.workspace,
      operationId: "hidden-flags",
      ownerBinding: "fixture-owner",
    });
    expect(snapshot.version).toBe(2);
    const manifestPath = NodePath.join(test.root, "saved", snapshot.id, "manifest.json");
    await NodeFSP.writeFile(manifestPath, JSON.stringify({ ...snapshot, version: 1 }));
    await expect(test.store.read(snapshot.id)).rejects.toThrow("snapshot format is unsupported");
    await NodeFSP.writeFile(manifestPath, JSON.stringify(snapshot));
    await test.store.trialRestore(snapshot.id);
    await test.store.isolate(snapshot.id, {
      quarantineParent: NodePath.join(test.root, "quarantine"),
    });
    await test.store.removeIsolated(snapshot.id);
    await test.store.restore(snapshot.id, { destinationPath: test.workspace });
    for (const name of names)
      expect(
        (
          await execute("/usr/bin/stat", ["-f", "%f", NodePath.join(test.workspace, name)])
        ).stdout.trim(),
      ).toBe("32768");
    expect(await NodeFSP.readFile(NodePath.join(test.workspace, ".DS_Store"), "utf8")).toBe(
      "finder data",
    );
  },
);

it.runIf(HostProcess.Platform.defaultValue() === "darwin")(
  "refuses hidden metadata on the excluded Git pointer before hashing content",
  async () => {
    await using test = await fixture();
    const pointer = NodePath.join(test.workspace, ".git");
    const contents = await NodeFSP.readFile(pointer);
    await execute("/usr/bin/chflags", ["hidden", pointer]);
    using reads = vi.spyOn(NodeFSP, "open");
    await expect(
      test.store.capture({
        sourcePath: test.workspace,
        operationId: "hidden-git-pointer",
        ownerBinding: "fixture-owner",
      }),
    ).rejects.toThrow("filesystem flags are unsupported");
    expect(
      reads.mock.calls.filter(
        ([name]) =>
          typeof name === "string" &&
          name.startsWith(`${test.workspace}/`) &&
          !name.endsWith("/.git"),
      ),
    ).toEqual([]);
    expect(await NodeFSP.readFile(pointer)).toEqual(contents);
    expect((await execute("/usr/bin/stat", ["-f", "%f", pointer])).stdout.trim()).toBe("32768");
  },
);

it.runIf(HostProcess.Platform.defaultValue() === "darwin")(
  "retains a workspace whose hidden flag changes after verification",
  async () => {
    await using test = await fixture();
    const file = NodePath.join(test.workspace, "tracked.txt");
    await execute("/usr/bin/chflags", ["hidden", file]);
    const snapshot = await test.store.capture({
      sourcePath: test.workspace,
      operationId: "changed-flags",
      ownerBinding: "fixture-owner",
    });
    await test.store.trialRestore(snapshot.id);
    await execute("/usr/bin/chflags", ["nohidden", file]);
    await expect(
      test.store.isolate(snapshot.id, { quarantineParent: NodePath.join(test.root, "quarantine") }),
    ).rejects.toThrow("workspace contents changed");
    expect(await NodeFSP.readFile(file, "utf8")).toBe("unstaged\n");
  },
);

it.runIf(HostProcess.Platform.defaultValue() === "darwin")(
  "refuses unsupported filesystem flags before hashing content",
  async () => {
    await using test = await fixture();
    const file = NodePath.join(test.workspace, "tracked.txt");
    await execute("/usr/bin/chflags", ["nodump", file]);
    using reads = vi.spyOn(NodeFSP, "open");
    await expect(
      test.store.capture({
        sourcePath: test.workspace,
        operationId: "unsupported-flags",
        ownerBinding: "fixture-owner",
      }),
    ).rejects.toThrow("filesystem flags are unsupported");
    expect(
      reads.mock.calls.filter(
        ([name]) =>
          typeof name === "string" &&
          name.startsWith(`${test.workspace}/`) &&
          !name.endsWith("/.git"),
      ),
    ).toEqual([]);
    expect(await NodeFSP.readFile(file, "utf8")).toBe("unstaged\n");
    expect((await execute("/usr/bin/stat", ["-f", "%f", file])).stdout.trim()).toBe("1");
  },
);

it
  .runIf(HostProcess.Platform.defaultValue() === "darwin")
  .each(["", "tracked.txt", "notes", "../saved"])(
  "refuses unsupported xattrs at '%s' and retains source bytes and metadata",
  async (relative) => {
    await using test = await fixture();
    const path = NodePath.join(test.workspace, relative);
    if (relative === "../saved") await NodeFSP.mkdir(path, { mode: 0o700 });
    const attribute = "com.apple.provenance.fixture";
    await execute("/usr/bin/xattr", ["-sw", attribute, "retain me", path]);
    const indexPath = NodePath.join(test.repository, ".git", "worktrees", "workspace", "index");
    const index = await NodeFSP.readFile(indexPath);
    using reads = vi.spyOn(NodeFSP, "open");
    await expect(
      test.store.capture({
        sourcePath: test.workspace,
        operationId: "xattr",
        ownerBinding: "fixture-owner",
      }),
    ).rejects.toThrow("extended attributes are unsupported");
    expect(
      reads.mock.calls.filter(
        ([name]) =>
          typeof name === "string" &&
          name.startsWith(`${test.workspace}/`) &&
          !name.endsWith("/.git"),
      ),
    ).toEqual([]);
    expect(await NodeFSP.readFile(indexPath)).toEqual(index);
    expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
      "unstaged\n",
    );
    expect(await NodeFSP.readFile(NodePath.join(test.workspace, "notes", "private"), "utf8")).toBe(
      "ignored note\n",
    );
    expect((await execute("/usr/bin/xattr", ["-sp", attribute, path])).stdout.trim()).toBe(
      "retain me",
    );
  },
);

it.runIf(HostProcess.Platform.defaultValue() === "darwin")(
  "still refuses provenance without fixture normalization",
  async () => {
    await using test = await fixture(false);
    await execute("/usr/bin/xattr", ["-sw", "com.apple.provenance", "fixture", test.workspace]);
    await expect(
      test.store.capture({
        sourcePath: test.workspace,
        operationId: "provenance",
        ownerBinding: "fixture-owner",
      }),
    ).rejects.toThrow("extended attributes are unsupported");
    expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
      "unstaged\n",
    );
  },
);

it.runIf(HostProcess.Platform.defaultValue() === "darwin")(
  "roundtrips FinderInfo on the root, directories and .DS_Store without losing raw bytes",
  async () => {
    await using test = await fixture();
    await NodeFSP.writeFile(NodePath.join(test.workspace, ".DS_Store"), "finder data");
    const extra = [
      { path: ".DS_Store", name: "com.apple.ResourceFork", hex: "0001ff00" },
      { path: "notes", name: "com.apple.metadata:_kMDItemUserTags", hex: "" },
    ];
    for (const item of extra)
      await execute("/usr/bin/xattr", [
        "-swx",
        item.name,
        item.hex,
        NodePath.join(test.workspace, item.path),
      ]);
    const value = "0123456789abcdef".repeat(4);
    for (const name of ["", "notes", ".DS_Store", "tracked.txt", "link"])
      await execute("/usr/bin/xattr", [
        "-swx",
        "com.apple.FinderInfo",
        value,
        NodePath.join(test.workspace, name),
      ]);
    const snapshot = await test.store.capture({
      sourcePath: test.workspace,
      operationId: "finder",
      ownerBinding: "fixture-owner",
    });
    await test.store.trialRestore(snapshot.id);
    await test.store.isolate(snapshot.id, {
      quarantineParent: NodePath.join(test.root, "quarantine"),
    });
    await test.store.removeIsolated(snapshot.id);
    await test.store.restore(snapshot.id, { destinationPath: test.workspace });
    for (const name of ["", "notes", ".DS_Store", "tracked.txt", "link"])
      expect(
        (
          await execute("/usr/bin/xattr", [
            "-spx",
            "com.apple.FinderInfo",
            NodePath.join(test.workspace, name),
          ])
        ).stdout
          .replace(/\s/gu, "")
          .toLowerCase(),
      ).toBe(value);
    for (const item of extra)
      expect(
        (
          await execute("/usr/bin/xattr", [
            "-spx",
            item.name,
            NodePath.join(test.workspace, item.path),
          ])
        ).stdout
          .replace(/\s/gu, "")
          .toLowerCase(),
      ).toBe(item.hex);
    expect(await NodeFSP.readFile(NodePath.join(test.workspace, ".DS_Store"), "utf8")).toBe(
      "finder data",
    );
  },
);

it
  .runIf(HostProcess.Platform.defaultValue() === "darwin")
  .each(["", "notes", "tracked.txt", "link"])(
  "retains the isolated checkout when attributes change at '%s', including after removal preparation",
  async (relative) => {
    await using test = await fixture();
    const attribute = "com.apple.metadata:_kMDItemUserTags";
    await execute("/usr/bin/xattr", [
      "-swx",
      attribute,
      "0001ff",
      NodePath.join(test.workspace, relative),
    ]);
    const snapshot = await test.store.capture({
      sourcePath: test.workspace,
      operationId: "attribute-change",
      ownerBinding: "fixture-owner",
    });
    await test.store.trialRestore(snapshot.id);
    const isolated = await test.store.isolate(snapshot.id, {
      quarantineParent: NodePath.join(test.root, "quarantine"),
    });
    const path = NodePath.join(isolated.isolatedPath!, relative);
    await execute("/usr/bin/xattr", ["-swx", attribute, "0002ff", path]);
    await expect(test.store.verifyIsolated(snapshot.id)).rejects.toThrow("contents changed");
    await execute("/usr/bin/xattr", ["-swx", attribute, "0001ff", path]);
    await test.store.prepareRemoval(snapshot.id);
    await execute("/usr/bin/xattr", ["-sd", attribute, path]);
    await expect(test.store.finishRemoval(snapshot.id)).rejects.toThrow("changed before removal");
    expect(
      await NodeFSP.readFile(NodePath.join(isolated.isolatedPath!, "tracked.txt"), "utf8"),
    ).toBe("unstaged\n");
  },
);

it.runIf(HostProcess.Platform.defaultValue() === "darwin")(
  "bounds attribute values before hashing and validates saved attribute records",
  async () => {
    await using test = await fixture();
    const path = NodePath.join(test.workspace, "tracked.txt");
    await execute("/usr/bin/xattr", [
      "-swx",
      "com.apple.ResourceFork",
      "ab".repeat(64 * 1024 + 1),
      path,
    ]);
    using reads = vi.spyOn(NodeFSP, "open");
    await expect(
      test.store.capture({
        sourcePath: test.workspace,
        operationId: "attribute-limit",
        ownerBinding: "fixture-owner",
      }),
    ).rejects.toThrow("value limit");
    expect(
      reads.mock.calls.filter(
        ([name]) =>
          typeof name === "string" &&
          name.startsWith(`${test.workspace}/`) &&
          !name.endsWith("/.git"),
      ),
    ).toEqual([]);
    await execute("/usr/bin/xattr", ["-sd", "com.apple.ResourceFork", path]);
    const snapshot = await test.store.capture({
      sourcePath: test.workspace,
      operationId: "attribute-manifest",
      ownerBinding: "fixture-owner",
    });
    const manifest = NodePath.join(test.root, "saved", snapshot.id, "manifest.json");
    const attribute = { path: "tracked.txt", name: "com.apple.ResourceFork", hex: "00" };
    for (const attributes of [
      [{ ...attribute, path: "../outside" }],
      [{ ...attribute, name: "com.apple.provenance" }],
      [{ ...attribute, hex: "0x" }],
      [{ ...attribute, hex: "00".repeat(64 * 1024 + 1) }],
      [attribute, attribute],
      Array.from({ length: 4097 }, () => attribute),
    ]) {
      await NodeFSP.writeFile(manifest, JSON.stringify({ ...snapshot, attributes }));
      await expect(test.store.read(snapshot.id)).rejects.toThrow("extended attributes");
    }
    // Already deployed version 1 snapshots remain readable without metadata fields.
    await NodeFSP.writeFile(manifest, JSON.stringify({ ...snapshot, version: 1 }));
    expect((await test.store.read(snapshot.id)).version).toBe(1);
    expect((await test.store.read(snapshot.id)).attributes).toBeUndefined();
    await test.store.trialRestore(snapshot.id);
  },
);

it.runIf(HostProcess.Platform.defaultValue() === "darwin")(
  "keeps the original and a recoverable snapshot when an attribute write fails in trial restore",
  async () => {
    await using test = await fixture();
    await execute("/usr/bin/xattr", [
      "-swx",
      "com.apple.FinderInfo",
      "01".repeat(32),
      test.workspace,
    ]);
    const snapshot = await test.store.capture({
      sourcePath: test.workspace,
      operationId: "attribute-write",
      ownerBinding: "fixture-owner",
    });
    const native = await vi.importActual<typeof NodeChildProcess>("node:child_process");
    const original = fixtureMetadataExecFile(test.root, native.execFile);
    using _failure = vi.spyOn(NodeChildProcess, "execFile").mockImplementation(((
      ...parameters: Parameters<typeof NodeChildProcess.execFile>
    ) => {
      const [program, args] = parameters;
      if (program === "/usr/bin/xattr" && args?.[0] === "-swx")
        return original("/usr/bin/false", [], parameters[2], parameters[3]);
      return original(...parameters);
    }) as typeof NodeChildProcess.execFile);
    await expect(test.store.trialRestore(snapshot.id)).rejects.toThrow(
      "xattr could not complete verification",
    );
    expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
      "unstaged\n",
    );
    await test.store.verify(snapshot.id);
  },
);

it.runIf(HostProcess.Platform.defaultValue() === "darwin")(
  "rejects an unreadable attribute and the aggregate byte limit before hashing",
  async () => {
    await using test = await fixture();
    const path = NodePath.join(test.workspace, "tracked.txt");
    await execute("/usr/bin/xattr", ["-swx", "com.apple.ResourceFork", "ab".repeat(1024), path]);
    const bounded = createWorktreeSuspensionStore({
      storeRoot: NodePath.join(test.root, "bounded"),
      limits: { maxBytes: 512 },
    });
    await expect(
      bounded.capture({
        sourcePath: test.workspace,
        operationId: "attribute-bytes",
        ownerBinding: "fixture-owner",
      }),
    ).rejects.toThrow("extended attributes exceed the byte limit");
    const native = await vi.importActual<typeof NodeChildProcess>("node:child_process");
    const original = fixtureMetadataExecFile(test.root, native.execFile);
    using _failure = vi.spyOn(NodeChildProcess, "execFile").mockImplementation(((
      ...parameters: Parameters<typeof NodeChildProcess.execFile>
    ) => {
      if (parameters[0] === "/usr/bin/xattr" && parameters[1]?.[0] === "-spx")
        return original("/usr/bin/false", [], parameters[2], parameters[3]);
      return original(...parameters);
    }) as typeof NodeChildProcess.execFile);
    using reads = vi.spyOn(NodeFSP, "open");
    await expect(
      test.store.capture({
        sourcePath: test.workspace,
        operationId: "attribute-read",
        ownerBinding: "fixture-owner",
      }),
    ).rejects.toThrow("xattr could not complete verification");
    expect(
      reads.mock.calls.filter(
        ([name]) =>
          typeof name === "string" &&
          name.startsWith(`${test.workspace}/`) &&
          !name.endsWith("/.git"),
      ),
    ).toEqual([]);
  },
);

it("retains Linux sources when attribute inspection reports metadata or fails", async () => {
  await using test = await fixture();
  using _platform = vi.spyOn(HostProcess.Platform, "defaultValue").mockReturnValue("linux");
  const native = await vi.importActual<typeof NodeChildProcess>("node:child_process");
  using inspect = vi.spyOn(NodeChildProcess, "execFile");
  for (const program of ["/usr/bin/printf", "/usr/bin/false"]) {
    inspect.mockImplementation(((...parameters: Parameters<typeof NodeChildProcess.execFile>) => {
      if (parameters[0] === "getfattr")
        return native.execFile(program, ["user.fixture=value"], parameters[2], parameters[3]);
      return native.execFile(...parameters);
    }) as typeof NodeChildProcess.execFile);
    await expect(
      test.store.capture({
        sourcePath: test.workspace,
        operationId: "linux-attributes",
        ownerBinding: "fixture-owner",
      }),
    ).rejects.toThrow(
      program.endsWith("printf")
        ? "extended attributes are unsupported"
        : "getfattr could not complete verification",
    );
  }
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
});

it("preserves a real dirty linked worktree privately, isolates it, survives GC, and restores exact raw and staged state", async () => {
  await using test = await fixture();
  const indexBefore = await NodeFSP.readFile(
    NodePath.join(test.repository, ".git", "worktrees", "workspace", "index"),
  );
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    snapshotId: "roundtrip",
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  expect(
    await NodeFSP.readFile(
      NodePath.join(test.repository, ".git", "worktrees", "workspace", "index"),
    ),
  ).toEqual(indexBefore);
  expect(snapshot.rawBytes).toBeGreaterThan(0);
  expect(snapshot.savedBytes).toBeGreaterThan(0);
  expect(snapshot.entries).toContainEqual({ path: "empty", kind: "directory", mode: 0o755 });
  await test.store.trialRestore(snapshot.id);
  const isolated = await test.store.isolate(snapshot.id, {
    quarantineParent: NodePath.join(test.root, "quarantine"),
  });
  await expect(NodeFSP.lstat(test.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await NodeFSP.readFile(NodePath.join(isolated.isolatedPath!, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
  await test.store.verifyIsolated(snapshot.id);
  await test.store.removeIsolated(snapshot.id);
  await expect(NodeFSP.lstat(isolated.isolatedPath!)).rejects.toMatchObject({ code: "ENOENT" });
  await git(test.repository, "branch", "-D", "task");
  await git(test.repository, "reflog", "expire", "--expire=now", "--all");
  await git(test.repository, "gc", "--prune=now");
  const restored = await test.store.restore(snapshot.id, { destinationPath: test.workspace });
  expect(restored.head).toBe(test.head);
  expect(await git(test.workspace, "rev-parse", "HEAD")).toBe(test.head);
  expect(await git(test.workspace, "show", ":tracked.txt")).toBe("staged");
  expect(await git(test.workspace, "show", ":staged-add")).toBe("staged added");
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "staged-add"), "utf8")).toBe(
    "working added\n",
  );
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "filtered"), "utf8")).toBe(
    "RAW DIFFERENT\n",
  );
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "notes", "private"), "utf8")).toBe(
    "ignored note\n",
  );
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "binary"))).toEqual(
    Buffer.from([255, 0, 12, 0, 42]),
  );
  expect(await NodeFSP.readlink(NodePath.join(test.workspace, "link"))).toBe("../outside");
  expect((await NodeFSP.stat(NodePath.join(test.workspace, "tracked.txt"))).mode & 0o777).toBe(
    0o751,
  );
  expect(await NodeFSP.readdir(NodePath.join(test.workspace, "empty"))).toEqual([]);
  await expect(NodeFSP.lstat(NodePath.join(test.workspace, "deleted.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    NodeFSP.lstat(NodePath.join(test.workspace, "staged-delete.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(NodeFSP.lstat(test.sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  await test.store.finalizeRestore(snapshot.id);
  expect((await test.store.readJournal(snapshot.id)).phase).toBe("active");
});

it("reclaims interrupted capture payloads and partial pins only while the original remains", async () => {
  await using test = await fixture();
  let captures = 0;
  const store = createWorktreeSuspensionStore({
    storeRoot: NodePath.join(test.root, "incomplete"),
    onBoundary: async (phase) => {
      if (phase === "capturing" && ++captures === 2) throw new Error("capture interrupted");
    },
  });
  await expect(
    store.capture({
      sourcePath: test.workspace,
      snapshotId: "incomplete",
      operationId: "capture-job",
      ownerBinding: "owner",
    }),
  ).rejects.toThrow("capture interrupted");
  const directory = NodePath.join(test.root, "incomplete", "incomplete");
  expect((await NodeFSP.readdir(NodePath.join(directory, "objects"))).length).toBeGreaterThan(0);
  const journal = await store.readJournal("incomplete");
  expect(journal.captureRefs).toBeDefined();
  await git(test.repository, "update-ref", journal.captureRefs!.headRef, journal.captureRefs!.head);
  await expect(
    store.cleanupIncompleteCapture("incomplete", { operationId: "another-job" }),
  ).rejects.toThrow("operation changed");
  await store.cleanupIncompleteCapture("incomplete", { operationId: "capture-job" });
  expect((await store.readJournal("incomplete")).phase).toBe("capture-cancelled");
  expect(await NodeFSP.readdir(directory)).toEqual(["journal.json"]);
  expect(await git(test.repository, "for-each-ref", "refs/lastcode/suspension/incomplete/")).toBe(
    "",
  );
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "notes/private"), "utf8")).toBe(
    "ignored note\n",
  );
  expect(await git(test.workspace, "show", ":tracked.txt")).toBe("staged");
  await store.cleanupIncompleteCapture("incomplete", { operationId: "capture-job" });
});

it("retains unknown capture-store additions and resumes an interrupted exact cleanup", async () => {
  await using test = await fixture();
  let captures = 0;
  let interruptCleanup = true;
  const root = NodePath.join(test.root, "partial");
  const store = createWorktreeSuspensionStore({
    storeRoot: root,
    onBoundary: async (phase) => {
      if (phase === "capturing" && ++captures === 2) throw new Error("capture interrupted");
      if (phase === "capture-cleanup" && interruptCleanup) throw new Error("cleanup interrupted");
    },
  });
  await expect(
    store.capture({
      sourcePath: test.workspace,
      snapshotId: "partial",
      operationId: "job",
      ownerBinding: "owner",
    }),
  ).rejects.toThrow("capture interrupted");
  const note = NodePath.join(root, "partial", "retained-note");
  await NodeFSP.writeFile(note, "unknown addition", { mode: 0o600 });
  await expect(store.cleanupIncompleteCapture("partial", { operationId: "job" })).rejects.toThrow(
    "unknown additions",
  );
  expect(await NodeFSP.readFile(note, "utf8")).toBe("unknown addition");
  expect((await store.readJournal("partial")).phase).toBe("capturing");
  await NodeFSP.unlink(note);
  await expect(store.cleanupIncompleteCapture("partial", { operationId: "job" })).rejects.toThrow(
    "cleanup interrupted",
  );
  interruptCleanup = false;
  const restarted = createWorktreeSuspensionStore({ storeRoot: root });
  await restarted.cleanupIncompleteCapture("partial", { operationId: "job" });
  expect((await restarted.readJournal("partial")).phase).toBe("capture-cancelled");
  expect(await NodeFSP.readdir(NodePath.join(root, "partial"))).toEqual(["journal.json"]);
});

it("never treats a published recovery manifest as an incomplete capture", async () => {
  await using test = await fixture();
  const saved = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "job",
    ownerBinding: "owner",
  });
  await expect(
    test.store.cleanupIncompleteCapture(saved.id, { operationId: "job" }),
  ).rejects.toThrow("complete or unresolved");
  await test.store.verify(saved.id);
});

it("retains the original and drains payload writes after a failed durability flush", async () => {
  await using test = await fixture();
  const storeRoot = NodePath.join(test.root, "flush-failure");
  const store = createWorktreeSuspensionStore({ storeRoot });
  const index = NodePath.join(test.repository, ".git", "worktrees", "workspace", "index");
  const originalIndex = await NodeFSP.readFile(index);
  const { open } = await vi.importActual<typeof NodeFSP>("node:fs/promises");
  let attempts = 0;
  let completed = 0;
  const intercepted = vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (
      typeof args[0] === "string" &&
      args[0].startsWith(storeRoot) &&
      args[0].endsWith(".tmp") &&
      NodePath.basename(NodePath.dirname(args[0])) === "objects"
    ) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        const attempt = ++attempts;
        try {
          if (attempt === 1)
            throw Object.assign(new Error("injected payload flush failure"), { code: "ENOSPC" });
          await sync();
        } finally {
          completed += 1;
        }
      };
    }
    return handle;
  });
  try {
    await expect(
      store.capture({
        sourcePath: test.workspace,
        snapshotId: "failed",
        operationId: "job",
        ownerBinding: "owner",
      }),
    ).rejects.toThrow("injected payload flush failure");
  } finally {
    intercepted.mockRestore();
  }
  expect(attempts).toBeGreaterThan(0);
  expect(completed).toBe(attempts);
  expect(await NodeFSP.readFile(index)).toEqual(originalIndex);
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "notes/private"), "utf8")).toBe(
    "ignored note\n",
  );
  await expect(
    NodeFSP.lstat(NodePath.join(storeRoot, "failed", "manifest.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await store.cleanupIncompleteCapture("failed", { operationId: "job" });
  expect(await NodeFSP.readdir(NodePath.join(storeRoot, "failed"))).toEqual(["journal.json"]);
});

it("cancels only uncommitted discard intent and restores its exact prior phase", async () => {
  await using test = await fixture();
  const saved = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "job",
    ownerBinding: "owner",
  });
  await test.store.keepOriginal(saved.id);
  await test.store.beginDiscard(saved.id);
  const restarted = createWorktreeSuspensionStore({ storeRoot: NodePath.join(test.root, "saved") });
  expect((await restarted.cancelDiscardIntent(saved.id)).phase).toBe("active");
  await restarted.verify(saved.id);
  await restarted.beginDiscard(saved.id);
  await restarted.commitDiscard(saved.id);
  await expect(restarted.cancelDiscardIntent(saved.id)).rejects.toThrow("after commitment");
  expect((await restarted.readJournal(saved.id)).phase).toBe("discarding");
});

it("returns a cancelled absent-workspace discard to suspended without restoring files", async () => {
  await using test = await fixture();
  const saved = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "job",
    ownerBinding: "owner",
  });
  await test.store.trialRestore(saved.id);
  await test.store.isolate(saved.id, { quarantineParent: NodePath.join(test.root, "quarantine") });
  await test.store.removeIsolated(saved.id);
  await test.store.beginDiscard(saved.id);
  expect((await test.store.cancelDiscardIntent(saved.id)).phase).toBe("suspended");
  await expect(NodeFSP.lstat(test.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  await test.store.verify(saved.id);
});

it("keeps late edits and rolls isolation back when a fresh guard refuses", async () => {
  await using test = await fixture();
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  await test.store.trialRestore(snapshot.id);
  await expect(
    test.store.suspend(snapshot.id, {
      quarantineParent: NodePath.join(test.root, "quarantine"),
      guard: async ({ isolatedPath }) => {
        await NodeFSP.writeFile(NodePath.join(isolatedPath, "late-note"), "arrived late");
        throw new Error("native consumer arrived");
      },
    }),
  ).rejects.toThrow("native consumer arrived");
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "late-note"), "utf8")).toBe(
    "arrived late",
  );
  expect((await test.store.readJournal(snapshot.id)).phase).toBe("ready");
});

it("keeps the original for unsupported hardlinks, intent-to-add, and bounded capture", async () => {
  await using test = await fixture();
  await NodeFSP.link(
    NodePath.join(test.workspace, "tracked.txt"),
    NodePath.join(test.workspace, "hardlink"),
  );
  using reads = vi.spyOn(NodeFSP, "open");
  await expect(
    test.store.capture({
      sourcePath: test.workspace,
      operationId: "operation",
      ownerBinding: "fixture-owner",
    }),
  ).rejects.toThrow("hardlinked");
  expect(
    reads.mock.calls.filter(
      ([name]) =>
        typeof name === "string" &&
        name.startsWith(`${test.workspace}/`) &&
        !name.endsWith("/.git"),
    ),
  ).toEqual([]);
  await NodeFSP.unlink(NodePath.join(test.workspace, "hardlink"));
  await NodeFSP.writeFile(NodePath.join(test.workspace, "intent"), "intent");
  await git(test.workspace, "add", "--intent-to-add", "intent");
  await expect(
    test.store.capture({
      sourcePath: test.workspace,
      operationId: "operation",
      ownerBinding: "fixture-owner",
    }),
  ).rejects.toThrow("extended Git index");
  const bounded = createWorktreeSuspensionStore({
    storeRoot: NodePath.join(test.root, "bounded"),
    limits: { maxBytes: 1 },
  });
  await expect(
    bounded.capture({
      sourcePath: test.workspace,
      operationId: "operation",
      ownerBinding: "fixture-owner",
    }),
  ).rejects.toThrow("byte limit");
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
});

it("retains a complete snapshot after a durable removal-boundary interruption and refuses occupied restoration", async () => {
  await using test = await fixture();
  const store = createWorktreeSuspensionStore({
    storeRoot: NodePath.join(test.root, "interrupted"),
    onBoundary: async (phase) => {
      if (phase === "removing") throw new Error("simulated stop");
    },
  });
  const snapshot = await store.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  await store.trialRestore(snapshot.id);
  const isolated = await store.isolate(snapshot.id, {
    quarantineParent: NodePath.join(test.root, "quarantine"),
  });
  await expect(store.removeIsolated(snapshot.id)).rejects.toThrow("simulated stop");
  expect((await store.readJournal(snapshot.id)).phase).toBe("removing");
  await store.verify(snapshot.id);
  expect(await NodeFSP.readFile(NodePath.join(isolated.isolatedPath!, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
});

it("blocks corruption and occupied paths and discards only the exact saved artifacts without restoration", async () => {
  await using test = await fixture();
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    snapshotId: "discard",
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  await test.store.trialRestore(snapshot.id);
  await test.store.suspend(snapshot.id, {
    quarantineParent: NodePath.join(test.root, "quarantine"),
    guard: async () => {},
  });
  await NodeFSP.mkdir(test.workspace);
  await NodeFSP.writeFile(NodePath.join(test.workspace, "external"), "occupied");
  await expect(
    test.store.restore(snapshot.id, { destinationPath: test.workspace }),
  ).rejects.toThrow("occupied");
  let committed = false;
  await test.store.discard(snapshot.id, {
    commit: async () => {
      committed = true;
    },
  });
  expect(committed).toBe(true);
  expect((await test.store.readJournal(snapshot.id)).phase).toBe("discarded");
  await expect(test.store.read(snapshot.id)).rejects.toThrow("deliberately discarded");
  await expect(
    NodeFSP.lstat(NodePath.join(test.root, "saved", snapshot.id, "objects")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "external"), "utf8")).toBe(
    "occupied",
  );
  expect(await git(test.repository, "rev-parse", "refs/heads/task")).toBe(test.head);
});

it("round-trips only empty or absent uninitialized gitlinks without requiring external commit objects", async () => {
  await using test = await fixture();
  const externalCommit = "1234567890123456789012345678901234567890";
  await git(
    test.workspace,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${externalCommit},uninitialized`,
  );
  await git(
    test.workspace,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${externalCommit},absent-submodule`,
  );
  await NodeFSP.mkdir(NodePath.join(test.workspace, "uninitialized"));
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  await test.store.trialRestore(snapshot.id);
  await test.store.suspend(snapshot.id, {
    quarantineParent: NodePath.join(test.root, "quarantine"),
    guard: async () => {},
  });
  await test.store.restore(snapshot.id, { destinationPath: test.workspace });
  expect(await git(test.workspace, "ls-files", "--stage", "uninitialized")).toBe(
    `160000 ${externalCommit} 0\tuninitialized`,
  );
  expect(await NodeFSP.readdir(NodePath.join(test.workspace, "uninitialized"))).toEqual([]);
  await expect(
    NodeFSP.lstat(NodePath.join(test.workspace, "absent-submodule")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps late-populated gitlink files and refuses worktree-local configuration", async () => {
  await using test = await fixture();
  const gitDirectory = NodePath.join(test.repository, ".git", "worktrees", "workspace");
  await NodeFSP.writeFile(
    NodePath.join(gitDirectory, "config.worktree"),
    "[core]\n  sparseCheckout = false\n",
  );
  await expect(
    test.store.capture({
      sourcePath: test.workspace,
      operationId: "operation",
      ownerBinding: "fixture-owner",
    }),
  ).rejects.toThrow("unsupported private Git metadata");
  await NodeFSP.unlink(NodePath.join(gitDirectory, "config.worktree"));
  await git(
    test.workspace,
    "update-index",
    "--add",
    "--cacheinfo",
    "160000,1234567890123456789012345678901234567890,uninitialized",
  );
  await NodeFSP.mkdir(NodePath.join(test.workspace, "uninitialized"));
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  await test.store.trialRestore(snapshot.id);
  const isolated = await test.store.isolate(snapshot.id, {
    quarantineParent: NodePath.join(test.root, "quarantine"),
  });
  await NodeFSP.writeFile(
    NodePath.join(isolated.isolatedPath!, "uninitialized", "note"),
    "late note",
  );
  await expect(test.store.removeIsolated(snapshot.id)).rejects.toThrow("populated submodule");
  expect(
    await NodeFSP.readFile(NodePath.join(isolated.isolatedPath!, "uninitialized", "note"), "utf8"),
  ).toBe("late note");
  expect((await test.store.readJournal(snapshot.id)).phase).toBe("isolated");
});

it("preserves known private Git metadata and pins fetched recovery commits through GC", async () => {
  await using test = await fixture();
  const gitDirectory = NodePath.join(test.repository, ".git", "worktrees", "workspace");
  const tree = await git(test.repository, "rev-parse", "HEAD^{tree}");
  const fetched = await git(
    test.repository,
    "commit-tree",
    tree,
    "-m",
    "recovery metadata fixture",
  );
  const originalLog = await NodeFSP.readFile(NodePath.join(gitDirectory, "logs", "HEAD"));
  const metadata = new Map([
    ["ORIG_HEAD", `${fetched}\n`],
    ["FETCH_HEAD", `${fetched}\t\tbranch 'fixture' of repository.example\n`],
    ["COMMIT_EDITMSG", "unfinished local message\n"],
    ["t3-dependency-activity.json", '{"version":1,"usedAt":123}\n'],
  ]);
  for (const [name, contents] of metadata)
    await NodeFSP.writeFile(NodePath.join(gitDirectory, name), contents);
  await NodeFSP.mkdir(NodePath.join(gitDirectory, "refs"), { recursive: true });
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  await test.store.trialRestore(snapshot.id);
  await test.store.suspend(snapshot.id, {
    quarantineParent: NodePath.join(test.root, "quarantine"),
    guard: async () => {},
  });
  await git(test.repository, "reflog", "expire", "--expire=now", "--all");
  await git(test.repository, "gc", "--prune=now");
  expect(await git(test.repository, "cat-file", "-t", fetched)).toBe("commit");
  await test.store.restore(snapshot.id, { destinationPath: test.workspace });
  const restoredDirectory = await git(test.workspace, "rev-parse", "--absolute-git-dir");
  for (const [name, contents] of metadata)
    expect(await NodeFSP.readFile(NodePath.join(restoredDirectory, name), "utf8")).toBe(contents);
  expect(await NodeFSP.readFile(NodePath.join(restoredDirectory, "logs", "HEAD"))).toEqual(
    originalLog,
  );
  expect(await NodeFSP.readdir(NodePath.join(restoredDirectory, "refs"))).toEqual([]);
});

it("preserves AUTO_MERGE tree closure and MERGE_RR bytes through suspension, GC, and restore", async () => {
  await using test = await fixture();
  const gitDirectory = await git(test.workspace, "rev-parse", "--absolute-git-dir");
  const content = NodePath.join(test.root, "merge-result");
  await NodeFSP.writeFile(content, "uncommitted auto-merge result\n");
  const blob = await git(test.repository, "hash-object", "-w", content);
  const index = NodePath.join(test.root, "merge-index");
  const mergeGit = async (...args: ReadonlyArray<string>) =>
    (
      await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd: test.repository,
        env: { ...process.env, GIT_INDEX_FILE: index },
      })
    ).stdout.trim();
  await mergeGit("read-tree", "--empty");
  await mergeGit("update-index", "--add", "--cacheinfo", `100644,${blob},nested/merged.txt`);
  const tree = await mergeGit("write-tree");
  const mergeRr = Buffer.from(`${blob}\tconflicted-file\0`);
  await NodeFSP.writeFile(NodePath.join(gitDirectory, "AUTO_MERGE"), `${tree}\n`, { mode: 0o640 });
  await NodeFSP.writeFile(NodePath.join(gitDirectory, "MERGE_RR"), mergeRr, { mode: 0o600 });
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  expect(snapshot.gitRefs).toContainEqual({
    ref: expect.any(String),
    object: tree,
    type: "tree",
    source: "AUTO_MERGE",
  });
  await test.store.trialRestore(snapshot.id);
  await test.store.suspend(snapshot.id, {
    quarantineParent: NodePath.join(test.root, "quarantine"),
    guard: async () => {},
  });
  await git(test.repository, "reflog", "expire", "--expire=now", "--all");
  await git(test.repository, "gc", "--prune=now");
  expect(await git(test.repository, "cat-file", "-t", tree)).toBe("tree");
  expect(await git(test.repository, "cat-file", "-p", `${tree}:nested/merged.txt`)).toBe(
    "uncommitted auto-merge result",
  );
  await test.store.restore(snapshot.id, { destinationPath: test.workspace });
  const restored = await git(test.workspace, "rev-parse", "--absolute-git-dir");
  expect(await NodeFSP.readFile(NodePath.join(restored, "AUTO_MERGE"), "utf8")).toBe(`${tree}\n`);
  expect(await NodeFSP.readFile(NodePath.join(restored, "MERGE_RR"))).toEqual(mergeRr);
  expect((await NodeFSP.stat(NodePath.join(restored, "AUTO_MERGE"))).mode & 0o777).toBe(0o640);
  expect((await NodeFSP.stat(NodePath.join(restored, "MERGE_RR"))).mode & 0o777).toBe(0o600);
  expect(await git(test.workspace, "show", ":tracked.txt")).toBe("staged");
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
  await test.store.finalizeRestore(snapshot.id);
});

it("keeps the source and private merge metadata when the AUTO_MERGE tree is missing", async () => {
  await using test = await fixture();
  const gitDirectory = await git(test.workspace, "rev-parse", "--absolute-git-dir");
  const missing = "1234567890123456789012345678901234567890";
  const mergeRr = Buffer.from([0, 255, 10, 0, 42]);
  await NodeFSP.writeFile(NodePath.join(gitDirectory, "AUTO_MERGE"), `${missing}\n`);
  await NodeFSP.writeFile(NodePath.join(gitDirectory, "MERGE_RR"), mergeRr);
  await expect(
    test.store.capture({
      sourcePath: test.workspace,
      operationId: "operation",
      ownerBinding: "fixture-owner",
    }),
  ).rejects.toThrow("private Git recovery objects are missing or unsupported");
  expect(await NodeFSP.readFile(NodePath.join(gitDirectory, "AUTO_MERGE"), "utf8")).toBe(
    `${missing}\n`,
  );
  expect(await NodeFSP.readFile(NodePath.join(gitDirectory, "MERGE_RR"))).toEqual(mergeRr);
  expect(await git(test.workspace, "show", ":tracked.txt")).toBe("staged");
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
  expect(await git(test.repository, "for-each-ref", "refs/lastcode/suspension/")).toBe("");
});

it("restores Git-backed base and staged bytes after actual source removal while preserving raw local work", async () => {
  await using test = await fixture();
  await NodeFSP.writeFile(NodePath.join(test.workspace, "staged-only"), "staged-only bytes\n");
  await git(test.workspace, "add", "staged-only");
  await NodeFSP.writeFile(NodePath.join(test.workspace, "untracked-note"), "untracked bytes\n");
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  const payloadPath = (path: string) => {
    const entry = snapshot.entries.find((entry) => entry.path === path);
    if (entry?.kind !== "file") throw new Error("fixture file missing");
    return NodePath.join(test.root, "saved", snapshot.id, "objects", `${entry.hash}.gz`);
  };
  await expect(NodeFSP.lstat(payloadPath(".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(NodeFSP.lstat(payloadPath("staged-only"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await NodeFSP.lstat(payloadPath("tracked.txt"))).isFile()).toBe(true);
  expect((await NodeFSP.lstat(payloadPath("untracked-note"))).isFile()).toBe(true);
  await test.store.trialRestore(snapshot.id);
  await test.store.suspend(snapshot.id, {
    quarantineParent: NodePath.join(test.root, "quarantine"),
    guard: async () => {},
  });
  await expect(NodeFSP.lstat(test.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  await git(test.repository, "branch", "-D", "task");
  await git(test.repository, "reflog", "expire", "--expire=now", "--all");
  await git(test.repository, "gc", "--prune=now");
  await test.store.restore(snapshot.id, { destinationPath: test.workspace });
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, ".gitignore"), "utf8")).toBe(
    "notes/\n",
  );
  expect(await git(test.workspace, "show", ":staged-only")).toBe("staged-only bytes");
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "staged-only"), "utf8")).toBe(
    "staged-only bytes\n",
  );
  expect(await git(test.workspace, "show", ":tracked.txt")).toBe("staged");
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "untracked-note"), "utf8")).toBe(
    "untracked bytes\n",
  );
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "notes/private"), "utf8")).toBe(
    "ignored note\n",
  );
  expect(await NodeFSP.readlink(NodePath.join(test.workspace, "link"))).toBe("../outside");
  await test.store.finalizeRestore(snapshot.id);
});

it("keeps Git-backed sources when WIP payloads are missing or corrupt or a required Git blob is missing", async () => {
  await using test = await fixture();
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  const wip = snapshot.entries.find((entry) => entry.path === "tracked.txt");
  if (wip?.kind !== "file") throw new Error("fixture file missing");
  const payload = NodePath.join(test.root, "saved", snapshot.id, "objects", `${wip.hash}.gz`);
  const original = await NodeFSP.readFile(payload);
  await NodeFSP.writeFile(payload, "corrupt gzip");
  await expect(test.store.trialRestore(snapshot.id)).rejects.toThrow();
  await NodeFSP.unlink(payload);
  await expect(test.store.trialRestore(snapshot.id)).rejects.toMatchObject({ code: "ENOENT" });
  await NodeFSP.writeFile(payload, original, { mode: 0o600 });
  const blob = await git(test.workspace, "rev-parse", ":.gitignore");
  await NodeFSP.unlink(
    NodePath.join(test.repository, ".git", "objects", blob.slice(0, 2), blob.slice(2)),
  );
  await expect(test.store.trialRestore(snapshot.id)).rejects.toThrow();
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
  expect((await test.store.readJournal(snapshot.id)).phase).toBe("verifying");
});

it("restores existing full-payload capsules without requiring a new manifest format", async () => {
  await using test = await fixture();
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  for (const entry of snapshot.entries) {
    if (entry.kind !== "file") continue;
    const payload = NodePath.join(test.root, "saved", snapshot.id, "objects", `${entry.hash}.gz`);
    try {
      await NodeFSP.lstat(payload);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await NodeFSP.writeFile(
        payload,
        NodeZlib.gzipSync(await NodeFSP.readFile(NodePath.join(test.workspace, entry.path))),
        { mode: 0o600 },
      );
    }
  }
  await test.store.trialRestore(snapshot.id);
  await test.store.suspend(snapshot.id, {
    quarantineParent: NodePath.join(test.root, "quarantine"),
    guard: async () => {},
  });
  await test.store.restore(snapshot.id, { destinationPath: test.workspace });
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, ".gitignore"), "utf8")).toBe(
    "notes/\n",
  );
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
  expect(await git(test.workspace, "show", ":tracked.txt")).toBe("staged");
  await test.store.finalizeRestore(snapshot.id);
});

it("preserves stale FETCH_HEAD bytes with already-missing history while pinning available fetched commits", async () => {
  await using test = await fixture();
  const gitDirectory = await git(test.workspace, "rev-parse", "--absolute-git-dir");
  const tree = await git(test.repository, "rev-parse", "HEAD^{tree}");
  const fetched = await git(
    test.repository,
    "commit-tree",
    tree,
    "-m",
    "available fetched history",
  );
  const missing = "1234567890123456789012345678901234567890";
  const fetchHead = `${missing}\tnot-for-merge\told branch of repository.example\n${fetched}\t\tcurrent branch of repository.example\n`;
  await NodeFSP.writeFile(NodePath.join(gitDirectory, "FETCH_HEAD"), fetchHead, { mode: 0o640 });
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  expect(snapshot.gitRefs.some((ref) => ref.object === fetched)).toBe(true);
  expect(snapshot.gitRefs.some((ref) => ref.object === missing)).toBe(false);
  await test.store.trialRestore(snapshot.id);
  await test.store.suspend(snapshot.id, {
    quarantineParent: NodePath.join(test.root, "quarantine"),
    guard: async () => {},
  });
  await expect(NodeFSP.lstat(test.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  await git(test.repository, "reflog", "expire", "--expire=now", "--all");
  await git(test.repository, "gc", "--prune=now");
  expect(await git(test.repository, "cat-file", "-t", fetched)).toBe("commit");
  await test.store.restore(snapshot.id, { destinationPath: test.workspace });
  const restored = await git(test.workspace, "rev-parse", "--absolute-git-dir");
  expect(await NodeFSP.readFile(NodePath.join(restored, "FETCH_HEAD"), "utf8")).toBe(fetchHead);
  expect((await NodeFSP.stat(NodePath.join(restored, "FETCH_HEAD"))).mode & 0o777).toBe(0o640);
  expect(await git(test.workspace, "show", ":tracked.txt")).toBe("staged");
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
  await test.store.finalizeRestore(snapshot.id);
});

it("preserves same-length unstaged edits through Git-backed capture, suspension, GC, and restore", async () => {
  await using test = await fixture();
  await NodeFSP.writeFile(NodePath.join(test.workspace, "tracked.txt"), "edited\n");
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  const edited = snapshot.entries.find((entry) => entry.path === "tracked.txt");
  if (edited?.kind !== "file") throw new Error("fixture file missing");
  expect(
    (
      await NodeFSP.lstat(
        NodePath.join(test.root, "saved", snapshot.id, "objects", `${edited.hash}.gz`),
      )
    ).isFile(),
  ).toBe(true);
  await test.store.trialRestore(snapshot.id);
  await test.store.suspend(snapshot.id, {
    quarantineParent: NodePath.join(test.root, "quarantine"),
    guard: async () => {},
  });
  await expect(NodeFSP.lstat(test.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  await git(test.repository, "branch", "-D", "task");
  await git(test.repository, "reflog", "expire", "--expire=now", "--all");
  await git(test.repository, "gc", "--prune=now");
  await test.store.restore(snapshot.id, { destinationPath: test.workspace });
  expect(await git(test.workspace, "show", ":tracked.txt")).toBe("staged");
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
    "edited\n",
  );
  await test.store.finalizeRestore(snapshot.id);
});

it("survives an actual process death after removal intent is fsynced", async () => {
  await using test = await fixture();
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  await test.store.trialRestore(snapshot.id);
  const child = NodeChildProcess.fork(
    new URL("./__fixtures__/worktree-suspension-stop.ts", import.meta.url),
    [NodePath.join(test.root, "saved"), snapshot.id, NodePath.join(test.root, "quarantine")],
    { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error("fixture exited before durable boundary")));
    });
    child.kill("SIGKILL");
    await closed;
    expect((await test.store.readJournal(snapshot.id)).phase).toBe("removing");
    await test.store.verify(snapshot.id);
    expect(
      await NodeFSP.readFile(
        NodePath.join(test.root, "quarantine", snapshot.id, "notes", "private"),
        "utf8",
      ),
    ).toBe("ignored note\n");
    await expect(NodeFSP.lstat(test.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
});

it("refuses corrupt payloads and insufficient space while retaining the complete original", async () => {
  await using test = await fixture();
  const bounded = createWorktreeSuspensionStore({
    storeRoot: NodePath.join(test.root, "low-space"),
    limits: { reserveBytes: Number.MAX_SAFE_INTEGER },
  });
  await expect(
    bounded.capture({
      sourcePath: test.workspace,
      operationId: "operation",
      ownerBinding: "fixture-owner",
    }),
  ).rejects.toThrow("insufficient space");
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  const file = snapshot.entries.find((entry) => entry.kind === "file");
  if (file?.kind !== "file") throw new Error("fixture file missing");
  await NodeFSP.writeFile(
    NodePath.join(test.root, "saved", snapshot.id, "objects", `${file.hash}.gz`),
    "damaged",
  );
  await expect(test.store.trialRestore(snapshot.id)).rejects.toThrow();
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "notes", "private"), "utf8")).toBe(
    "ignored note\n",
  );
});

it("reconciles an interrupted intact removal back to the original path", async () => {
  await using test = await fixture();
  const stopped = createWorktreeSuspensionStore({
    storeRoot: NodePath.join(test.root, "saved"),
    onBoundary: async (phase) => {
      if (phase === "removing") throw new Error("interrupted");
    },
  });
  const snapshot = await stopped.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  await stopped.trialRestore(snapshot.id);
  await stopped.isolate(snapshot.id, { quarantineParent: NodePath.join(test.root, "quarantine") });
  await expect(stopped.removeIsolated(snapshot.id)).rejects.toThrow("interrupted");
  expect((await test.store.reconcileRemoval(snapshot.id)).status).toBe("original-kept");
  await test.store.keepOriginal(snapshot.id);
  expect((await test.store.readJournal(snapshot.id)).phase).toBe("active");
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "notes", "private"), "utf8")).toBe(
    "ignored note\n",
  );
});

it("resumes a positively owned partial restore only from saved byte prefixes", async () => {
  await using test = await fixture();
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  await test.store.trialRestore(snapshot.id);
  await test.store.suspend(snapshot.id, {
    quarantineParent: NodePath.join(test.root, "quarantine"),
    guard: async () => {},
  });
  let restoringBoundaries = 0;
  const stopped = createWorktreeSuspensionStore({
    storeRoot: NodePath.join(test.root, "saved"),
    onBoundary: async (phase) => {
      if (phase === "restoring" && ++restoringBoundaries === 3)
        throw new Error("interrupted after owned checkout creation");
    },
  });
  await expect(
    stopped.stageRestore(snapshot.id, { destinationPath: test.workspace }),
  ).rejects.toThrow("owned checkout creation");
  const journal = await test.store.readJournal(snapshot.id);
  await NodeFSP.writeFile(NodePath.join(journal.restorePath!, "tracked.txt"), "uns", {
    mode: 0o600,
  });
  const restored = await test.store.resumeRestore(snapshot.id);
  expect(restored.path).toBe(test.workspace);
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
  expect(await git(test.workspace, "show", ":tracked.txt")).toBe("staged");
  await test.store.finalizeRestore(snapshot.id);
});

it("recovers an already-published restore and finishes an exact committed disposal after interruption", async () => {
  await using test = await fixture();
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "operation",
    ownerBinding: "fixture-owner",
  });
  await test.store.trialRestore(snapshot.id);
  await test.store.suspend(snapshot.id, {
    quarantineParent: NodePath.join(test.root, "quarantine"),
    guard: async () => {},
  });
  let restoringBoundaries = 0;
  const stopped = createWorktreeSuspensionStore({
    storeRoot: NodePath.join(test.root, "saved"),
    onBoundary: async (phase) => {
      if (phase === "restoring" && ++restoringBoundaries === 5)
        throw new Error("interrupted after publish");
    },
  });
  await expect(stopped.restore(snapshot.id, { destinationPath: test.workspace })).rejects.toThrow(
    "after publish",
  );
  await test.store.resumeRestore(snapshot.id);
  await test.store.finalizeRestore(snapshot.id);
  await test.store.beginDiscard(snapshot.id);
  expect((await test.store.readJournal(snapshot.id)).phase).toBe("discard-intent");
  await test.store.verify(snapshot.id);
  const stoppedDiscard = createWorktreeSuspensionStore({
    storeRoot: NodePath.join(test.root, "saved"),
    onBoundary: async (phase) => {
      if (phase === "discarding") throw new Error("interrupted after consent");
    },
  });
  await expect(stoppedDiscard.commitDiscard(snapshot.id)).rejects.toThrow("after consent");
  await test.store.purgeDiscard(snapshot.id);
  expect((await test.store.readJournal(snapshot.id)).phase).toBe("discarded");
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
});

it("refuses a closed late write after preparation and restores the same moved root with its new bytes", async () => {
  await using test = await fixture();
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "late-write",
    ownerBinding: "fixture-owner",
  });
  await test.store.trialRestore(snapshot.id);
  const journal = await test.store.isolate(snapshot.id, {
    quarantineParent: NodePath.join(test.root, "quarantine"),
  });
  await test.store.prepareRemoval(snapshot.id);
  await NodeFSP.writeFile(
    NodePath.join(journal.isolatedPath!, "tracked.txt"),
    "closed late write\n",
  );
  await expect(test.store.finishRemoval(snapshot.id)).rejects.toThrow("changed before removal");
  expect((await test.store.reconcileRemoval(snapshot.id)).status).toBe("original-kept");
  expect(await NodeFSP.readFile(NodePath.join(test.workspace, "tracked.txt"), "utf8")).toBe(
    "closed late write\n",
  );
  expect((await test.store.readJournal(snapshot.id)).phase).toBe("ready");
});

it("privately retains build provenance bytes and rejects unknown Git metadata before removal", async () => {
  await using test = await fixture();
  const gitDirectory = (await test.store.inspectSource(test.workspace)).gitDirectory;
  const receipt = `t3-build-${"a".repeat(64)}.json`;
  const bytes = '{"version":1,"opaque":"retain without adopting provenance"}\n';
  await NodeFSP.writeFile(NodePath.join(gitDirectory, receipt), bytes);
  const snapshot = await test.store.capture({
    sourcePath: test.workspace,
    operationId: "build-provenance",
    ownerBinding: "fixture-owner",
  });
  await test.store.trialRestore(snapshot.id);
  const journal = await test.store.isolate(snapshot.id, {
    quarantineParent: NodePath.join(test.root, "quarantine"),
  });
  await test.store.prepareRemoval(snapshot.id);
  await NodeFSP.writeFile(
    NodePath.join(gitDirectory, "unknown-operation-journal"),
    "retain this too\n",
  );
  await expect(test.store.finishRemoval(snapshot.id)).rejects.toThrow("changed before removal");
  await NodeFSP.unlink(NodePath.join(gitDirectory, "unknown-operation-journal"));
  expect((await test.store.reconcileRemoval(snapshot.id)).status).toBe("original-kept");
  await test.store.keepOriginal(snapshot.id);
  const restoredPath = NodePath.join(test.root, "recovered-build-provenance");
  await test.store.restore(snapshot.id, { destinationPath: restoredPath });
  const restored = await test.store.inspectSource(restoredPath);
  expect(await NodeFSP.readFile(NodePath.join(restored.gitDirectory, receipt), "utf8")).toBe(bytes);
  expect(restored.sourceIdentity).not.toEqual(snapshot.sourceIdentity);
  expect(await NodeFSP.readFile(NodePath.join(journal.sourcePath!, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
});
