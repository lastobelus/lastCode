const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const script = path.join(__dirname, "lastcode-upstream-delta.cjs");

test("counts endpoint changes over pinned paths through replay and nightly merges", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-delta-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const write = (name, content) => fs.writeFileSync(path.join(cwd, name), content);
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const report = (base, head) => {
    const summary = path.join(cwd, ".git", "summary.md");
    fs.rmSync(summary, { force: true });
    const result = spawnSync(process.execPath, [script, base, head], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(summary, "utf8"), result.stdout);
    return result.stdout;
  };

  git("init", "-q", "-b", "upstream");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  write("owned.txt", "one\ntwo\nthree\n");
  write("removed.txt", "removed\n");
  write("renamed.txt", "renamed\n");
  write("odd\tname\n.txt", "old\n");
  write("binary.dat", Buffer.from([0, 1, 2]));
  const pinned = commit("upstream nightly");
  git("update-ref", "refs/remotes/origin/main", pinned);
  git("checkout", "-qb", "fork");
  write("owned.txt", "one\nfork\nthree\n");
  const base = commit("carry");
  write("fork-only.txt", "fork-only\n");
  const forkOnly = commit("fork-only PR");
  assert.match(report(base, forkOnly), /\| This PR \| 0 \| 0 \|/);

  // The upstream mirror moves ahead, but this PR's ownership stays pinned to its base.
  git("checkout", "-q", "upstream");
  write("fork-only.txt", "now upstream\n");
  const nextNightly = commit("next upstream nightly");
  git("update-ref", "refs/remotes/origin/main", nextNightly);
  git("checkout", "-q", "fork");
  write("owned.txt", "one\npr\nthree\nadded\n");
  fs.rmSync(path.join(cwd, "removed.txt"));
  git("mv", "renamed.txt", "fork-renamed.txt");
  write("odd\tname\n.txt", "new\n");
  write("binary.dat", Buffer.from([0, 3, 4]));
  const head = commit("upstream-owned PR");
  const output = report(base, head);
  assert.match(output, /\| This PR \| 3 \| 4 \|/);
  assert.match(output, /\| Whole fork \| 3 \| 4 \|/);
  assert.ok(output.includes(pinned));
  assert.match(output, /Binary files.*excluded/);

  // A transient edit and its revert add no endpoint churn.
  write("owned.txt", "temporary\n");
  commit("temporary edit");
  git("revert", "--no-edit", "HEAD");
  assert.match(report(head, "HEAD"), /\| This PR \| 0 \| 0 \|/);

  // B1's possible merge-based nightly workflow retains upstream ancestry.
  git("merge", "-s", "ours", "--no-edit", "upstream");
  const mergedBase = git("rev-parse", "HEAD");
  write("fork-only.txt", "changed after nightly merge\n");
  const mergedHead = commit("PR after nightly merge");
  const merged = report(mergedBase, mergedHead);
  assert.ok(merged.includes(nextNightly));
  assert.match(merged, /\| This PR \| 1 \| 1 \|/);
});

test("reports unavailable inputs and summary write failures without failing", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-delta-errors-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [script, "missing-base", "missing-head"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: cwd },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Upstream-owned line changes unavailable/);
  assert.match(result.stderr, /summary/i);
});
