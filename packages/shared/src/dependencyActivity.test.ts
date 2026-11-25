// @effect-diagnostics nodeBuiltinImport:off -- Native allocation and symlink fixtures exercise filesystem identity boundaries.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { assert, it, onTestFinished } from "vite-plus/test";
import {
  RECENT_DEPENDENCY_USAGE_SKIP_MS,
  observeDependencyActivity,
  recentVerifiedDependencyActivity,
  recordDependencyUse,
  dependencyActivitySnapshot,
} from "./dependencyActivity.ts";

const fixture = () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dependency-activity-")),
  );
  onTestFinished(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const cwd = NodePath.join(root, "worktree");
  const gitDir = NodePath.join(root, "git-metadata");
  const deps = NodePath.join(cwd, "node_modules");
  NodeFS.mkdirSync(gitDir);
  NodeFS.mkdirSync(NodePath.join(deps, "package"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(cwd, ".git"), `gitdir: ${gitDir}\n`);
  NodeFS.writeFileSync(NodePath.join(deps, ".modules.yaml"), "layoutVersion: 5\n");
  return { root, cwd, gitDir, deps };
};

it("legacy allocations get a full period; inspection alone does not keep renewing it", () => {
  const { cwd, gitDir, deps } = fixture();
  NodeFS.utimesSync(deps, 0, 0);
  assert.deepEqual(observeDependencyActivity(gitDir, cwd, 100), { lastUsedAt: 100, renewed: true });
  assert.deepEqual(observeDependencyActivity(gitDir, cwd, 200), {
    lastUsedAt: 100,
    renewed: false,
  });
  assert.deepEqual(observeDependencyActivity(gitDir, cwd, 300, true), {
    lastUsedAt: 300,
    renewed: true,
  });
  assert.equal(observeDependencyActivity(gitDir, cwd, 400).lastUsedAt, 300);
});

it("replacement and installer marker updates renew the period without consuming retained files", () => {
  const { cwd, gitDir, deps } = fixture();
  observeDependencyActivity(gitDir, cwd, 100);
  NodeFS.writeFileSync(NodePath.join(deps, ".modules.yaml"), "updated installer metadata\n");
  assert.equal(observeDependencyActivity(gitDir, cwd, 200).lastUsedAt, 200);
  NodeFS.renameSync(deps, `${deps}-retained`);
  NodeFS.mkdirSync(deps);
  NodeFS.writeFileSync(NodePath.join(deps, ".modules.yaml"), "layoutVersion: 5\n");
  assert.equal(observeDependencyActivity(gitDir, cwd, 300).lastUsedAt, 300);
  assert.isTrue(NodeFS.existsSync(`${deps}-retained`));
});

it("nested app-managed use renews age; corrupt and linked records fail closed", () => {
  const { cwd, gitDir, deps, root } = fixture();
  observeDependencyActivity(gitDir, cwd, 100);
  recordDependencyUse(NodePath.join(deps, "package"), 200);
  assert.equal(observeDependencyActivity(gitDir, cwd, 300).lastUsedAt, 200);
  const record = NodePath.join(gitDir, "t3-dependency-activity.json");
  NodeFS.writeFileSync(record, "invalid");
  assert.throws(() => observeDependencyActivity(gitDir, cwd, 400));
  assert.equal(NodeFS.readFileSync(record, "utf8"), "invalid");
  NodeFS.unlinkSync(record);
  const retained = NodePath.join(root, "retained.json");
  NodeFS.writeFileSync(retained, "retained consent");
  NodeFS.symlinkSync(retained, record);
  assert.throws(() => observeDependencyActivity(gitDir, cwd, 500));
  assert.equal(NodeFS.readFileSync(retained, "utf8"), "retained consent");
});

it("final revalidation is read-only, detects renewal and preserves approval records", () => {
  const { cwd, gitDir, deps } = fixture();
  observeDependencyActivity(gitDir, cwd, 100);
  const consent = NodePath.join(gitDir, "reviewed-worktree.json");
  NodeFS.writeFileSync(consent, "one-use consent remains unchanged");
  const activity = NodePath.join(gitDir, "t3-dependency-activity.json");
  const original = NodeFS.readFileSync(activity, "utf8");
  NodeFS.writeFileSync(NodePath.join(deps, ".modules.yaml"), "new marker\n");
  assert.deepEqual(observeDependencyActivity(gitDir, cwd, 200, false, false), {
    lastUsedAt: 200,
    renewed: true,
  });
  assert.equal(NodeFS.readFileSync(activity, "utf8"), original);
  assert.equal(NodeFS.readFileSync(consent, "utf8"), "one-use consent remains unchanged");
  assert.equal(observeDependencyActivity(gitDir, cwd, 300).lastUsedAt, 300);
});

it("final snapshots detect renewal at the same timestamp without writing activity", () => {
  const { cwd, gitDir } = fixture();
  observeDependencyActivity(gitDir, cwd, 100);
  const before = dependencyActivitySnapshot(cwd);
  assert.equal(dependencyActivitySnapshot(cwd), before);
  observeDependencyActivity(gitDir, cwd, 100, true);
  assert.notEqual(dependencyActivitySnapshot(cwd), before);
});

it("Finder and directory-only metadata changes do not renew dependency use", () => {
  const { cwd, gitDir, deps } = fixture();
  observeDependencyActivity(gitDir, cwd, 100);
  NodeFS.writeFileSync(NodePath.join(cwd, ".DS_Store"), "fixture metadata");
  NodeFS.writeFileSync(NodePath.join(deps, ".DS_Store"), "fixture metadata");
  assert.deepEqual(observeDependencyActivity(gitDir, cwd, 200), {
    lastUsedAt: 100,
    renewed: false,
  });
});

it("final snapshots detect a rebound Git directory even without an activity record", () => {
  const { cwd, root } = fixture();
  const before = dependencyActivitySnapshot(cwd);
  const other = NodePath.join(root, "other-git-metadata");
  NodeFS.mkdirSync(other);
  NodeFS.writeFileSync(NodePath.join(cwd, ".git"), `gitdir: ${other}\n`);
  assert.notEqual(dependencyActivitySnapshot(cwd), before);
  assert.isFalse(NodeFS.existsSync(NodePath.join(other, "t3-dependency-activity.json")));
});

it("recentVerifiedDependencyActivity skips only within 24h of verified use for the same in-retention install", () => {
  const { cwd, gitDir, deps } = fixture();
  const base = 1_000_000_000;
  const hour = 3_600_000;
  const recordPath = NodePath.join(gitDir, "t3-dependency-activity.json");

  assert.isNull(recentVerifiedDependencyActivity(gitDir, cwd, base, 7));

  observeDependencyActivity(gitDir, cwd, base);
  assert.isNull(recentVerifiedDependencyActivity(gitDir, cwd, base + hour, 7));

  const legacyPayload = JSON.parse(NodeFS.readFileSync(recordPath, "utf8"));
  assert.isUndefined(legacyPayload.verifiedUseAt);
  assert.equal(observeDependencyActivity(gitDir, cwd, base + 2 * hour).lastUsedAt, base);

  recordDependencyUse(NodePath.join(deps, "package"), base + 3 * hour);
  const afterUseSnapshot = dependencyActivitySnapshot(cwd);
  for (const checkAt of [
    base + 3 * hour,
    base + 4 * hour,
    base + 3 * hour + RECENT_DEPENDENCY_USAGE_SKIP_MS - 1,
  ]) {
    assert.deepEqual(recentVerifiedDependencyActivity(gitDir, cwd, checkAt, 7), {
      lastUsedAt: base + 3 * hour,
      renewed: false,
    });
    assert.equal(dependencyActivitySnapshot(cwd), afterUseSnapshot);
  }

  assert.isNull(
    recentVerifiedDependencyActivity(
      gitDir,
      cwd,
      base + 3 * hour + RECENT_DEPENDENCY_USAGE_SKIP_MS,
      7,
    ),
  );
  assert.isNull(
    recentVerifiedDependencyActivity(
      gitDir,
      cwd,
      base + 3 * hour + RECENT_DEPENDENCY_USAGE_SKIP_MS + 1,
      7,
    ),
  );
  assert.isNull(recentVerifiedDependencyActivity(gitDir, cwd, base + 2 * hour, 7));

  observeDependencyActivity(gitDir, cwd, base + 4 * hour, true);
  assert.isNull(
    recentVerifiedDependencyActivity(
      gitDir,
      cwd,
      base + 4 * hour + RECENT_DEPENDENCY_USAGE_SKIP_MS,
      7,
    ),
  );
  // Retention cutoff still wins over <24h verified use (17h - 4h >= 12h, < 24h).
  assert.isNull(recentVerifiedDependencyActivity(gitDir, cwd, base + 17 * hour, 0.5));
  assert.isNull(recentVerifiedDependencyActivity(gitDir, cwd, base + 4 * hour + 7 * 24 * hour, 7));

  assert.deepEqual(recentVerifiedDependencyActivity(gitDir, cwd, base + 5 * hour, 7), {
    lastUsedAt: base + 4 * hour,
    renewed: false,
  });
  NodeFS.writeFileSync(NodePath.join(deps, ".modules.yaml"), "updated installer metadata\n");
  assert.isNull(recentVerifiedDependencyActivity(gitDir, cwd, base + 5 * hour, 7));
  observeDependencyActivity(gitDir, cwd, base + 5 * hour, false);
  assert.isNull(recentVerifiedDependencyActivity(gitDir, cwd, base + 6 * hour, 7));
});

it("recentVerifiedDependencyActivity fails closed on corrupt or symlinked records", () => {
  const { cwd, gitDir, root } = fixture();
  const base = 1_000_000_000;
  observeDependencyActivity(gitDir, cwd, base, true);
  const recordPath = NodePath.join(gitDir, "t3-dependency-activity.json");
  const valid = JSON.parse(NodeFS.readFileSync(recordPath, "utf8")) as Record<string, unknown>;

  for (const badVerifiedUseAt of [null, -1, 1.5, "100", base + 1]) {
    NodeFS.writeFileSync(recordPath, JSON.stringify({ ...valid, verifiedUseAt: badVerifiedUseAt }));
    assert.throws(() => recentVerifiedDependencyActivity(gitDir, cwd, base + 10, 7));
    assert.throws(() => observeDependencyActivity(gitDir, cwd, base + 10, false, false));
  }

  NodeFS.unlinkSync(recordPath);
  const outside = NodePath.join(root, "outside.json");
  NodeFS.writeFileSync(outside, JSON.stringify(valid));
  NodeFS.symlinkSync(outside, recordPath);
  assert.throws(() => recentVerifiedDependencyActivity(gitDir, cwd, base + 10, 7));
});
