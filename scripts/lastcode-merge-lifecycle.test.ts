// @effect-diagnostics nodeBuiltinImport:off -- Drives the real merge CLI against disposable Git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { githubCiRunTitle } from "./lastcode-github-ci.ts";
import { MAIN_WRITE_LOCK_REF } from "./lastcode-main-write-lock.ts";

describe("guarded merge lifecycle", () => {
  it.each([true, false])(
    "guards the final write without requesting a checkpoint (base advances: %s)",
    (advanceBase) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-merge-lifecycle-"));
      try {
        const repo = NodePath.join(root, "repo");
        const origin = NodePath.join(root, "origin.git");
        const bin = NodePath.join(root, "bin");
        const marker = NodePath.join(root, "merge-called");
        const checkpointMarker = NodePath.join(root, "checkpoint-requested");
        const home = NodePath.join(root, "home");
        NodeFS.mkdirSync(bin);
        NodeFS.mkdirSync(home);
        const env = {
          ...process.env,
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: NodePath.join(home, "missing-config"),
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.invalid",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.invalid",
        };
        const git = (cwd: string, args: ReadonlyArray<string>) =>
          NodeChildProcess.execFileSync("git", args, {
            cwd,
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
        git(root, ["init", "--bare", origin]);
        git(root, ["init", "--initial-branch=lastcode/main", repo]);
        NodeFS.mkdirSync(NodePath.join(repo, "scripts"));
        NodeFS.writeFileSync(NodePath.join(repo, "scripts", "lastcode-carry-set.json"), "{}\n");
        NodeFS.writeFileSync(
          NodePath.join(repo, "scripts", "lastcode-nightly-service.ts"),
          "import * as fs from 'node:fs'; fs.writeFileSync(process.env.TEST_CHECKPOINT_MARKER, 'called');\n",
        );
        git(repo, ["add", "."]);
        git(repo, ["commit", "-m", "source"]);
        const base = git(repo, ["rev-parse", "HEAD"]);
        git(repo, ["remote", "add", "origin", origin]);
        git(repo, ["push", "origin", "HEAD:refs/heads/lastcode/main"]);
        git(repo, ["checkout", "-b", "feature"]);
        git(repo, ["commit", "--allow-empty", "-m", "feature"]);
        const head = git(repo, ["rev-parse", "HEAD"]);
        const tree = git(repo, ["rev-parse", `${base}^{tree}`]);
        const advanced = git(repo, ["commit-tree", tree, "-p", base, "-m", "checkpoint"]);
        git(repo, ["push", "origin", `${advanced}:refs/test/advanced`]);
        if (advanceBase)
          NodeFS.writeFileSync(
            NodePath.join(origin, "hooks", "pre-receive"),
            `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "${MAIN_WRITE_LOCK_REF}" ] && [ "$old" = "0000000000000000000000000000000000000000" ]; then
    unset GIT_QUARANTINE_PATH
    git update-ref refs/heads/lastcode/main ${advanced} ${base} || exit 1
  fi
done
`,
            { mode: 0o755 },
          );
        const responses = {
          pr: {
            number: 1,
            body: "Feature",
            url: "https://github.com/example/repository/pull/1",
            state: "OPEN",
            isDraft: false,
            headRefOid: head,
            baseRefOid: base,
            baseRefName: "lastcode/main",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
          },
          workflow: { state: "active" },
          rules: [
            {
              type: "required_status_checks",
              parameters: { required_status_checks: [{ context: "CI Gate" }] },
            },
          ],
          runs: {
            workflow_runs: [
              {
                id: 1,
                display_title: githubCiRunTitle({
                  pullRequestNumber: 1,
                  headSha: head,
                  baseSha: base,
                  mergeSha: head,
                }),
                event: "pull_request",
                head_sha: head,
                status: "completed",
                conclusion: "success",
              },
            ],
          },
          jobs: { jobs: [{ name: "CI Gate", status: "completed", conclusion: "success" }] },
        };
        const responsesPath = NodePath.join(root, "responses.json");
        NodeFS.writeFileSync(responsesPath, JSON.stringify(responses));
        NodeFS.writeFileSync(
          NodePath.join(bin, "gh"),
          `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const responses = JSON.parse(fs.readFileSync(process.env.TEST_RESPONSES, 'utf8'));
const args = process.argv.slice(2);
let result;
if (args[0] === 'pr' && args[1] === 'merge') {
  cp.execFileSync('git', ['push', '--no-verify', 'origin', responses.pr.headRefOid + ':refs/heads/lastcode/main']);
  fs.writeFileSync(process.env.TEST_MERGE_MARKER, 'called');
  process.exit(0);
} else if (args[0] === 'pr' && args[1] === 'view') result = {...responses.pr, state: fs.existsSync(process.env.TEST_MERGE_MARKER) ? 'MERGED' : 'OPEN'};
else if (args[0] === 'api' && args[1].includes('/rules/branches/')) result = responses.rules;
else if (args[0] === 'api' && args[1].includes('/runs?')) result = responses.runs;
else if (args[0] === 'api' && args[1].includes('/jobs?')) result = responses.jobs;
else if (args[0] === 'api' && args[1].endsWith('/actions/workflows/ci.yml')) result = responses.workflow;
else throw new Error('Unexpected gh command: ' + args.join(' '));
process.stdout.write(JSON.stringify(result));
`,
          { mode: 0o755 },
        );
        const result = NodeChildProcess.spawnSync(
          process.execPath,
          [NodeURL.fileURLToPath(new URL("./lastcode-merge.ts", import.meta.url))],
          {
            cwd: repo,
            encoding: "utf8",
            env: {
              ...env,
              PATH: [bin, NodePath.dirname(process.execPath), process.env.PATH ?? ""].join(
                NodePath.delimiter,
              ),
              LASTCODE_GITHUB_REPOSITORY: "example/repository",
              TEST_RESPONSES: responsesPath,
              TEST_MERGE_MARKER: marker,
              TEST_CHECKPOINT_MARKER: checkpointMarker,
            },
          },
        );
        expect(result.status, result.stderr).toBe(advanceBase ? 1 : 0);
        if (advanceBase) expect(result.stderr).toContain(`moved from ${base} to ${advanced}`);
        else expect(result.stdout).toContain("Merge complete. No checkpoint requested.");
        expect(NodeFS.existsSync(marker)).toBe(!advanceBase);
        expect(NodeFS.existsSync(checkpointMarker)).toBe(false);
        expect(git(root, ["--git-dir", origin, "rev-parse", "refs/heads/lastcode/main"])).toBe(
          advanceBase ? advanced : head,
        );
        expect(
          git(root, [
            "--git-dir",
            origin,
            "for-each-ref",
            "--format=%(refname)",
            MAIN_WRITE_LOCK_REF,
          ]),
        ).toBe("");
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
