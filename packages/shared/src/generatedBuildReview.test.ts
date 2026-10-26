// @effect-diagnostics nodeBuiltinImport:off -- Native identity fixtures exercise exact-file deletion and durable protection.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { assert, expect, it, onTestFinished } from "vite-plus/test";
import { acquirePortableLock } from "../../../scripts/lastcode-lock.mjs";
import {
  createGeneratedBuildStage,
  generatedBuildActivity,
  generatedBuildReviewProtection,
  inspectGeneratedBuildOwnership,
  inspectReviewedBuildFilesAsync,
  legacyBuildActivity,
  observeLegacyBuild,
  previewLegacyBuild,
  recordLegacyBuildUse,
  removeGeneratedBuildFiles,
  removeGeneratedBuildFilesAsync,
  removeReviewedBuildFilesAsync,
  saveLegacyBuildSelection,
  validateLegacyBuildReviewContext,
} from "./generatedBuildOwnership.ts";

const rejects = (operation: Promise<unknown>, reason: string | RegExp) =>
  expect(operation).rejects.toThrow(reason);

const root = "apps/web/dist";
const policy = "project/repository/branch/owner/policy";
const fixture = () => {
  const temporary = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "build-review-")),
  );
  onTestFinished(() => NodeFS.rmSync(temporary, { recursive: true, force: true }));
  const cwd = NodePath.join(temporary, "worktree");
  const metadata = NodePath.join(temporary, "git-metadata");
  NodeFS.mkdirSync(cwd);
  NodeFS.mkdirSync(metadata);
  NodeFS.writeFileSync(NodePath.join(cwd, ".git"), `gitdir: ${metadata}\n`);
  const output = NodePath.join(cwd, root);
  const emit = (path: string, contents = path) => {
    const target = NodePath.join(output, path);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, contents);
    return target;
  };
  emit("assets/main.js", "compiled output");
  const receipt = () =>
    NodePath.join(
      metadata,
      NodeFS.readdirSync(metadata).find(
        (name) => name.startsWith("t3-build-review-") && name.endsWith(".json"),
      )!,
    );
  const approve = async (paths = ["assets/main.js"]) => {
    const preview = await previewLegacyBuild(cwd, root, 100, policy);
    return saveLegacyBuildSelection(cwd, root, 200, policy, preview.token, paths);
  };
  return { cwd, metadata, output, temporary, emit, receipt, approve };
};

it("starts a conservative first-observation clock, never adopts mtimes or compiler provenance", async () => {
  const { cwd, output } = fixture();
  NodeFS.utimesSync(output, 1, 1);
  assert.equal(legacyBuildActivity(cwd, root), null);
  assert.equal(observeLegacyBuild(cwd, root, 100, false)?.lastUsedAt, 100);
  assert.equal(legacyBuildActivity(cwd, root), null);
  const initial = observeLegacyBuild(cwd, root, 200)!;
  assert.isFalse(initial.hasSelection);
  assert.equal(observeLegacyBuild(cwd, root, 900)?.token, initial.token);
  const preview = await previewLegacyBuild(cwd, root, 1_000, policy);
  assert.equal(preview.lastUsedAt, 200);
  assert.deepEqual(preview.selectedPaths, []);
  assert.equal(generatedBuildActivity(cwd, root), null);
  assert.isFalse(generatedBuildReviewProtection(cwd));
  assert.isFalse(generatedBuildReviewProtection(cwd, "node_modules"));
});

it("removes only unchanged selected files once and preserves changed, recreated, new and unselected files", async () => {
  const { cwd, emit, output, approve } = fixture();
  emit("edited.js");
  emit("recreated.js");
  emit("notes.txt");
  const approval = await approve(["assets/main.js", "edited.js", "recreated.js"]);
  emit("edited.js", "a user changed this");
  NodeFS.unlinkSync(NodePath.join(output, "recreated.js"));
  emit("recreated.js");
  emit("new.txt");
  const result = await removeReviewedBuildFilesAsync(
    cwd,
    root,
    policy,
    approval.token,
    ["assets/main.js", "edited.js", "recreated.js"],
    async () => true,
  );
  assert.equal(result.files, 1);
  assert.isAbove(result.bytes, 0);
  assert.sameMembers(
    result.kept.map((file) => file.path),
    ["edited.js", "recreated.js"],
  );
  for (const path of ["edited.js", "recreated.js", "notes.txt", "new.txt"])
    assert.isTrue(NodeFS.existsSync(NodePath.join(output, path)));
  assert.isFalse(NodeFS.existsSync(NodePath.join(output, "assets/main.js")));
  const remaining = await inspectReviewedBuildFilesAsync(cwd, root, policy);
  assert.equal(remaining, null);
  assert.isFalse(legacyBuildActivity(cwd, root)?.hasSelection);
  assert.isTrue(generatedBuildReviewProtection(cwd));
  await rejects(
    removeReviewedBuildFilesAsync(
      cwd,
      root,
      policy,
      approval.token,
      ["assets/main.js"],
      async () => true,
    ),
    "review changed",
  );
});

it("empty and consumed approvals retain root/ancestor/descendant protection across regeneration", async () => {
  const { cwd, output, approve, emit } = fixture();
  const empty = await approve([]);
  assert.isFalse(empty.hasSelection);
  assert.equal(empty.lastUsedAt, 100);
  assert.equal(await inspectReviewedBuildFilesAsync(cwd, root, policy), null);
  for (const path of ["", "apps", "apps/web", root, `${root}/assets`])
    assert.isTrue(generatedBuildReviewProtection(cwd, path));
  assert.isFalse(generatedBuildReviewProtection(cwd, "node_modules"));
  assert.isFalse(generatedBuildReviewProtection(cwd, "apps/server/dist"));
  const approved = await approve();
  const removed = await removeReviewedBuildFilesAsync(
    cwd,
    root,
    policy,
    approved.token,
    ["assets/main.js"],
    async () => true,
  );
  assert.equal(removed.files, 1);
  assert.isFalse(NodeFS.existsSync(output));
  assert.equal(await inspectReviewedBuildFilesAsync(cwd, root, policy), null);
  assert.isTrue(generatedBuildReviewProtection(cwd));
  emit("new.txt", "added after consumed consent");
  const compiler = createGeneratedBuildStage(cwd, root)!;
  NodeFS.writeFileSync(NodePath.join(compiler.directory, "main.js"), "new compiler output");
  compiler.publish(300);
  const provenance = inspectGeneratedBuildOwnership(cwd, root)!;
  const sync = removeGeneratedBuildFiles(cwd, root, provenance.token, ["main.js"]);
  assert.equal(sync.files, 0);
  assert.match(sync.kept[0]!.reason, /protected/);
  const asyncResult = await removeGeneratedBuildFilesAsync(
    cwd,
    root,
    provenance.token,
    ["main.js"],
    async () => true,
  );
  assert.equal(asyncResult.files, 0);
  assert.match(asyncResult.kept[0]!.reason, /protected/);
  assert.isTrue(NodeFS.existsSync(NodePath.join(output, "new.txt")));
});

it("malformed, unreadable and mismatched markers fail closed without any surviving owner", async () => {
  const { cwd, approve, receipt, temporary } = fixture();
  await approve([]);
  const path = receipt();
  const valid = NodeFS.readFileSync(path, "utf8");
  NodeFS.writeFileSync(path, "broken JSON");
  assert.isTrue(generatedBuildReviewProtection(cwd, "node_modules"));
  assert.equal(await inspectReviewedBuildFilesAsync(cwd, root, policy), null);
  NodeFS.unlinkSync(path);
  NodeFS.symlinkSync(NodePath.join(temporary, "missing-record"), path);
  assert.isTrue(generatedBuildReviewProtection(cwd));
  NodeFS.unlinkSync(path);
  NodeFS.writeFileSync(
    path,
    valid.replace(/"worktreeIdentity":"[^"]+"/, '"worktreeIdentity":"replacement"'),
  );
  assert.isTrue(generatedBuildReviewProtection(cwd, "node_modules"));
});

it("context changes and positive actual use revoke authority while preview/save do not renew age", async () => {
  const { cwd, approve } = fixture();
  const approval = await approve();
  assert.equal(approval.lastUsedAt, 100);
  assert.equal((await previewLegacyBuild(cwd, root, 5_000, policy)).lastUsedAt, 100);
  assert.equal(await inspectReviewedBuildFilesAsync(cwd, root, "different owner or policy"), null);
  assert.equal(await inspectReviewedBuildFilesAsync(cwd, root, policy), null);
  await rejects(
    removeReviewedBuildFilesAsync(
      cwd,
      root,
      "different owner or policy",
      approval.token,
      ["assets/main.js"],
      async () => true,
    ),
    "review changed",
  );
  assert.isTrue(recordLegacyBuildUse(cwd, root, 600));
  assert.equal(legacyBuildActivity(cwd, root)?.lastUsedAt, 600);
  assert.isFalse(legacyBuildActivity(cwd, root)?.hasSelection);
  assert.equal(await inspectReviewedBuildFilesAsync(cwd, root, policy), null);
  assert.isTrue(generatedBuildReviewProtection(cwd));
});

it("replacement roots invalidate approval even when original selected inodes move into them", async () => {
  const { cwd, output, approve } = fixture();
  const approval = await approve();
  const original = NodePath.join(output, "assets/main.js");
  const inode = NodeFS.statSync(original).ino;
  const moved = `${output}-previous`;
  NodeFS.renameSync(output, moved);
  NodeFS.mkdirSync(NodePath.join(output, "assets"), { recursive: true });
  NodeFS.renameSync(NodePath.join(moved, "assets/main.js"), original);
  assert.equal(NodeFS.statSync(original).ino, inode);
  assert.equal(await inspectReviewedBuildFilesAsync(cwd, root, policy), null);
  await rejects(
    removeReviewedBuildFilesAsync(
      cwd,
      root,
      policy,
      approval.token,
      ["assets/main.js"],
      async () => true,
    ),
    "review changed",
  );
  assert.isTrue(generatedBuildReviewProtection(cwd));
  const observed = observeLegacyBuild(cwd, root, 800)!;
  assert.equal(observed.lastUsedAt, 800);
  assert.isFalse(observed.hasSelection);
});

it("preview refresh detects file additions, content changes, root replacement and policy changes", async () => {
  const { cwd, output, emit } = fixture();
  const first = await previewLegacyBuild(cwd, root, 100, policy);
  emit("new.txt");
  await rejects(
    saveLegacyBuildSelection(cwd, root, 200, policy, first.token, ["assets/main.js"]),
    "preview changed",
  );
  const second = await previewLegacyBuild(cwd, root, 100, policy);
  emit("assets/main.js", "changed");
  await rejects(
    saveLegacyBuildSelection(cwd, root, 200, policy, second.token, ["assets/main.js"]),
    "preview changed",
  );
  const third = await previewLegacyBuild(cwd, root, 100, policy);
  await rejects(
    saveLegacyBuildSelection(cwd, root, 200, "new policy", third.token, []),
    "preview changed",
  );
  NodeFS.renameSync(output, `${output}-previous`);
  emit("assets/main.js", "changed");
  await rejects(
    saveLegacyBuildSelection(cwd, root, 200, policy, third.token, []),
    "preview changed",
  );
});

it("shows links, hardlinks and unsafe names as unselectable and rejects their approval", async () => {
  const { cwd, output, emit } = fixture();
  emit("notes.txt");
  NodeFS.linkSync(NodePath.join(output, "notes.txt"), NodePath.join(output, "hard.txt"));
  NodeFS.symlinkSync("assets/main.js", NodePath.join(output, "linked.js"));
  emit("unsafe:name.txt");
  const preview = await previewLegacyBuild(cwd, root, 100, policy);
  assert.equal(preview.files.length, 5);
  assert.sameMembers(
    preview.files.filter((file) => !file.selectable).map((file) => file.path),
    ["notes.txt", "hard.txt", "linked.js", "unsafe:name.txt"],
  );
  for (const file of preview.files.filter((file) => !file.selectable))
    await rejects(
      saveLegacyBuildSelection(cwd, root, 200, policy, preview.token, [file.path]),
      "cannot be selected",
    );
});

it("rejects incomplete or oversized inventories without granting deletion authority", async () => {
  const { cwd, output, emit } = fixture();
  const huge = emit("huge.js", "");
  NodeFS.truncateSync(huge, 512 * 1024 * 1024 + 1);
  await rejects(previewLegacyBuild(cwd, root, 100, policy), "512 MiB");
  NodeFS.unlinkSync(huge);
  for (let index = 0; index < 1_000; index++) emit(`file-${index}.js`, "");
  await rejects(previewLegacyBuild(cwd, root, 100, policy), "1000 files");
  assert.isFalse(generatedBuildReviewProtection(cwd));
  assert.isTrue(NodeFS.existsSync(output));
});

it("admission rejects compiler provenance and pending publication, including after the last async guard", async () => {
  const { cwd, metadata } = fixture();
  const preview = await previewLegacyBuild(cwd, root, 100, policy);
  await rejects(
    saveLegacyBuildSelection(
      cwd,
      root,
      200,
      policy,
      preview.token,
      ["assets/main.js"],
      async () => {
        const stage = createGeneratedBuildStage(cwd, root)!;
        NodeFS.writeFileSync(NodePath.join(stage.directory, "new.js"), "compiler output");
        stage.publish(200);
        return true;
      },
    ),
    "compiler provenance",
  );
  assert.equal(await inspectReviewedBuildFilesAsync(cwd, root, policy), null);
  const record = NodeFS.readdirSync(metadata).find((name) =>
    /^t3-build-[a-f0-9]+\.json$/.test(name),
  )!;
  NodeFS.unlinkSync(NodePath.join(metadata, record));
  NodeFS.writeFileSync(NodePath.join(metadata, `${record}.pending`), "pending recovery");
  await rejects(previewLegacyBuild(cwd, root, 300, policy), "pending recovery");
});

it("selection and publisher share the same lock; no async guard executes while it is held", async () => {
  const { cwd, metadata, approve } = fixture();
  const preview = await previewLegacyBuild(cwd, root, 100, policy);
  const stage = createGeneratedBuildStage(cwd, root)!;
  NodeFS.writeFileSync(NodePath.join(stage.directory, "new.js"), "new compiler output");
  const compilerKey = NodeFS.readdirSync(metadata)
    .find((name) => name.startsWith("t3-build-review-"))!
    .replace("t3-build-review-", "t3-build-");
  let guards = 0;
  await saveLegacyBuildSelection(
    cwd,
    root,
    200,
    policy,
    preview.token,
    ["assets/main.js"],
    async () => {
      const release = acquirePortableLock(metadata, `${compilerKey}.publish`, "test live guard");
      release();
      guards++;
      return true;
    },
  );
  const approval = (await inspectReviewedBuildFilesAsync(cwd, root, policy))!;
  const release = acquirePortableLock(
    metadata,
    `${compilerKey}.publish`,
    "test competing publication",
  );
  try {
    const result = await removeReviewedBuildFilesAsync(
      cwd,
      root,
      policy,
      approval.token,
      ["assets/main.js"],
      async () => true,
    );
    assert.equal(result.files, 0);
    assert.match(result.kept[0]!.reason, /busy/);
    assert.throws(() => stage.publish(200), "Retry after");
    assert.throws(() => validateLegacyBuildReviewContext(cwd, root, policy), "Retry after");
    await rejects(approve(), "Retry after");
  } finally {
    release();
    stage.discard();
  }
  assert.equal(guards, 1);
});

it("final approval guards cannot change activity, inventory or selected identities unnoticed", async () => {
  const { cwd, emit } = fixture();
  for (const mutate of [
    () => {
      recordLegacyBuildUse(cwd, root, 500);
    },
    () => {
      emit("new.txt", "new");
    },
    () => {
      emit("assets/main.js", "edited");
    },
  ]) {
    const preview = await previewLegacyBuild(cwd, root, 100, policy);
    await rejects(
      saveLegacyBuildSelection(
        cwd,
        root,
        200,
        policy,
        preview.token,
        ["assets/main.js"],
        async () => {
          mutate();
          return true;
        },
      ),
      /changed/,
    );
    assert.equal(await inspectReviewedBuildFilesAsync(cwd, root, policy), null);
  }
});

it("guard refusal preserves pending consent and cancellation/partial batches report truthful totals", async () => {
  const { cwd, emit, approve } = fixture();
  for (let index = 0; index < 70; index++) emit(`file-${index}.js`);
  const paths = ["assets/main.js", ...Array.from({ length: 70 }, (_, index) => `file-${index}.js`)];
  const approval = await approve(paths);
  const refused = await removeReviewedBuildFilesAsync(
    cwd,
    root,
    policy,
    approval.token,
    paths,
    async () => false,
  );
  assert.equal(refused.files, 0);
  assert.equal(refused.kept.length, paths.length);
  assert.equal((await inspectReviewedBuildFilesAsync(cwd, root, policy))?.token, approval.token);
  const controller = new AbortController();
  let guards = 0;
  const partial = await removeReviewedBuildFilesAsync(
    cwd,
    root,
    policy,
    approval.token,
    paths,
    async () => {
      if (++guards === 2) controller.abort();
      return true;
    },
    controller.signal,
  );
  assert.equal(partial.files, 64);
  assert.equal(partial.kept.length, 7);
  assert.isTrue(partial.kept.every((file) => file.reason.includes("cancelled")));
  assert.equal(new Set(partial.kept.map((file) => file.path)).size, 7);
  assert.equal((await inspectReviewedBuildFilesAsync(cwd, root, policy))?.files.length, 7);
});

it("fresh final removal checks retain an edited file and refuse changed policy/use after hashing", async () => {
  const { cwd, emit, approve } = fixture();
  const approval = await approve();
  const changed = await removeReviewedBuildFilesAsync(
    cwd,
    root,
    policy,
    approval.token,
    ["assets/main.js"],
    async () => {
      emit("assets/main.js", "changed during awaited live guard");
      return true;
    },
  );
  assert.equal(changed.files, 0);
  assert.match(changed.kept[0]!.reason, /changed before removal/);
  const next = await approve();
  const used = await removeReviewedBuildFilesAsync(
    cwd,
    root,
    policy,
    next.token,
    ["assets/main.js"],
    async () => {
      recordLegacyBuildUse(cwd, root, 500);
      return true;
    },
  );
  assert.equal(used.files, 0);
  assert.match(used.kept[0]!.reason, /review changed/);
  assert.isTrue(generatedBuildReviewProtection(cwd));
});

it("replacing the worktree allocation cannot inherit a previous allocation's receipt", async () => {
  const { cwd, approve } = fixture();
  await approve();
  const previous = `${cwd}-previous`;
  NodeFS.renameSync(cwd, previous);
  NodeFS.mkdirSync(cwd);
  NodeFS.renameSync(NodePath.join(previous, ".git"), NodePath.join(cwd, ".git"));
  NodeFS.renameSync(NodePath.join(previous, "apps"), NodePath.join(cwd, "apps"));
  assert.equal(await inspectReviewedBuildFilesAsync(cwd, root, policy), null);
  assert.isTrue(generatedBuildReviewProtection(cwd, "node_modules"));
  await rejects(previewLegacyBuild(cwd, root, 500, policy), "Invalid build review record");
});

it("an observed absent selected subtree cannot regain approval when its original files return", async () => {
  const { cwd, output, approve } = fixture();
  await approve();
  NodeFS.renameSync(NodePath.join(output, "assets"), NodePath.join(output, "hidden-assets"));
  assert.equal(await inspectReviewedBuildFilesAsync(cwd, root, policy), null);
  NodeFS.renameSync(NodePath.join(output, "hidden-assets"), NodePath.join(output, "assets"));
  assert.equal(await inspectReviewedBuildFilesAsync(cwd, root, policy), null);
  assert.isFalse(legacyBuildActivity(cwd, root)?.hasSelection);
  assert.isTrue(generatedBuildReviewProtection(cwd));
});

it("a thrown late guard preserves completed-batch totals and keeps every remaining file", async () => {
  const { cwd, emit, approve } = fixture();
  const paths = Array.from({ length: 65 }, (_, index) => `file-${index}.js`);
  for (const path of paths) emit(path);
  const approved = await approve(paths);
  let checks = 0;
  const result = await removeReviewedBuildFilesAsync(
    cwd,
    root,
    policy,
    approved.token,
    paths,
    async () => {
      if (++checks === 2) throw new Error("Consumer inventory unavailable");
      return true;
    },
  );
  assert.equal(result.files, 64);
  assert.isAbove(result.bytes, 0);
  assert.deepEqual(result.kept, [
    { path: "file-64.js", reason: "Build cleanup guards could not be checked" },
  ]);
  assert.equal((await inspectReviewedBuildFilesAsync(cwd, root, policy))?.files.length, 1);
});

it("inspection retires stale consent and returns a fresh token that still removes valid selected siblings", async () => {
  const { cwd, emit, approve, output } = fixture();
  emit("edited.js");
  const approved = await approve(["assets/main.js", "edited.js"]);
  emit("edited.js", "retained edit");
  const inspected = (await inspectReviewedBuildFilesAsync(cwd, root, policy))!;
  assert.notEqual(inspected.token, approved.token);
  assert.equal(inspected.lastUsedAt, approved.lastUsedAt);
  assert.deepEqual(
    inspected.files.filter((file) => file.reason === null).map((file) => file.path),
    ["assets/main.js"],
  );
  const result = await removeReviewedBuildFilesAsync(
    cwd,
    root,
    policy,
    inspected.token,
    ["assets/main.js"],
    async () => true,
  );
  assert.equal(result.files, 1);
  assert.equal(NodeFS.readFileSync(NodePath.join(output, "edited.js"), "utf8"), "retained edit");
  assert.equal(await inspectReviewedBuildFilesAsync(cwd, root, policy), null);
});

it("metadata-only policy observation revokes consent before a longer inactivity rule can skip inspection", async () => {
  const { cwd, approve } = fixture();
  const approved = await approve();
  assert.isTrue(validateLegacyBuildReviewContext(cwd, root, policy));
  assert.equal(legacyBuildActivity(cwd, root)?.token, approved.token);
  assert.isFalse(
    validateLegacyBuildReviewContext(cwd, root, "same owner with a longer inactivity delay"),
  );
  assert.isFalse(validateLegacyBuildReviewContext(cwd, root, policy));
  assert.isFalse(legacyBuildActivity(cwd, root)?.hasSelection);
  assert.equal(legacyBuildActivity(cwd, root)?.lastUsedAt, approved.lastUsedAt);
  assert.equal(await inspectReviewedBuildFilesAsync(cwd, root, policy), null);
  assert.isTrue(generatedBuildReviewProtection(cwd));
  await rejects(
    removeReviewedBuildFilesAsync(
      cwd,
      root,
      policy,
      approved.token,
      ["assets/main.js"],
      async () => true,
    ),
    "review changed",
  );
});
