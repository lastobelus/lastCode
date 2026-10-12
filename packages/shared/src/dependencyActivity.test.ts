import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { assert, it, onTestFinished } from "vite-plus/test";
import {
  observeDependencyActivity,
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
