// @effect-diagnostics nodeBuiltinImport:off -- Drives the real merge CLI against disposable Git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { githubCiRunTitle } from "./lastcode-github-ci.ts";
import { MAIN_WRITE_LOCK_REF } from "./lastcode-main-write-lock.ts";
import { validateCarrySourceRange } from "./lastcode-carry-delivery.ts";
import { compileCarrySetSameBase } from "./lastcode-carry-replay.ts";
import { assertSupportedNodeVersion } from "./lastcode-local-ci.ts";

function fixtureNodeExecutable(): string {
  // Vite+ may host tests on a newer Node than the runtime required by the merge CLI.
  const candidates = [
    process.execPath,
    ...(process.env.PATH?.split(NodePath.delimiter).map((directory) =>
      NodePath.join(directory, "node"),
    ) ?? []),
  ];
  for (const node of new Set(candidates)) {
    if (!NodeFS.existsSync(node)) continue;
    const version = NodeChildProcess.spawnSync(node, ["-p", "process.versions.node"], {
      encoding: "utf8",
    });
    if (version.status !== 0) continue;
    try {
      assertSupportedNodeVersion(version.stdout.trim());
      return node;
    } catch {
      // Ignore an unrelated runtime on PATH.
    }
  }
  throw new Error("Merge lifecycle fixture requires the supported project Node on PATH.");
}

describe("guarded merge lifecycle", () => {
  it.each([
    { scenario: "base advances", advanceBase: true, carryGroup: undefined },
    { scenario: "base stays unchanged", advanceBase: false, carryGroup: undefined },
    { scenario: "carry regrouping conflicts", advanceBase: false, carryGroup: "build-ci" },
    {
      scenario: "carry compiles successfully",
      advanceBase: false,
      carryGroup: "resumable-actions",
    },
  ] as const)(
    "guards the final write without requesting a checkpoint: $scenario",
    ({ advanceBase, carryGroup }) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-merge-lifecycle-"));
      try {
        const repo = NodePath.join(root, "repo");
        const origin = NodePath.join(root, "origin.git");
        const bin = NodePath.join(root, "bin");
        const marker = NodePath.join(root, "merge-called");
        const lockMarker = NodePath.join(root, "lock-requested");
        const sourceMarker = NodePath.join(root, "source-published");
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
          LC_ALL: "C",
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
        git(repo, ["config", "user.name", "Test"]);
        git(repo, ["config", "user.email", "test@example.invalid"]);
        git(repo, ["config", "commit.gpgSign", "false"]);
        NodeFS.mkdirSync(NodePath.join(repo, "scripts"));
        NodeFS.writeFileSync(
          NodePath.join(repo, "scripts", "lastcode-carry-set.json"),
          `${JSON.stringify(carryGroup ? { replay: { mode: "carry" } } : {})}\n`,
        );
        NodeFS.writeFileSync(
          NodePath.join(repo, "scripts", "lastcode-nightly-service.ts"),
          "import * as fs from 'node:fs'; fs.writeFileSync(process.env.TEST_CHECKPOINT_MARKER, 'called');\n",
        );
        if (carryGroup) NodeFS.writeFileSync(NodePath.join(repo, "shared.txt"), "upstream\n");
        git(repo, ["add", "."]);
        git(repo, ["commit", "-m", "source"]);
        if (carryGroup) {
          const upstream = git(repo, ["rev-parse", "HEAD"]);
          NodeFS.writeFileSync(NodePath.join(repo, "shared.txt"), "action behavior\n");
          git(repo, ["add", "."]);
          git(repo, [
            "commit",
            "-m",
            "action modification",
            "-m",
            "Carry-Group: resumable-actions",
          ]);
          const contribution = git(repo, ["rev-parse", "HEAD"]);
          NodeFS.writeFileSync(
            NodePath.join(repo, "scripts", "lastcode-carry-set.json"),
            JSON.stringify({
              replay: {
                mode: "carry",
                bootstrap: { base: upstream, source: contribution, head: contribution },
              },
            }),
          );
          git(repo, ["add", "scripts/lastcode-carry-set.json"]);
          git(repo, ["commit", "-m", "activate carry replay", "-m", "Carry-Group: tooling"]);
          const partition = git(repo, ["rev-parse", "HEAD"]);
          compileCarrySetSameBase({
            repo,
            worktree: repo,
            base: upstream,
            source: partition,
            preparedPartition: { base: upstream, source: partition, head: partition },
          });
        }
        const base = git(repo, ["rev-parse", "HEAD"]);
        git(repo, ["remote", "add", "origin", origin]);
        git(repo, ["push", "origin", "HEAD:refs/heads/lastcode/main"]);
        git(repo, ["checkout", "-b", "feature"]);
        if (carryGroup) {
          git(repo, ["rm", "shared.txt"]);
          git(repo, ["commit", "-m", "remove modified file", "-m", `Carry-Group: ${carryGroup}`]);
        } else git(repo, ["commit", "--allow-empty", "-m", "feature"]);
        const head = git(repo, ["rev-parse", "HEAD"]);
        const source = carryGroup ? validateCarrySourceRange(repo, 1, base, head) : undefined;
        const tree = git(repo, ["rev-parse", `${base}^{tree}`]);
        const advanced = git(repo, ["commit-tree", tree, "-p", base, "-m", "checkpoint"]);
        git(repo, ["push", "origin", `${advanced}:refs/test/advanced`]);
        NodeFS.writeFileSync(
          NodePath.join(origin, "hooks", "pre-receive"),
          `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "${MAIN_WRITE_LOCK_REF}" ] && [ "$old" = "0000000000000000000000000000000000000000" ]; then
    printf 'called\\n' >> "$TEST_LOCK_MARKER"
    if [ "${advanceBase}" = "true" ]; then
      unset GIT_QUARANTINE_PATH
      git update-ref refs/heads/lastcode/main ${advanced} ${base} || exit 1
    fi
  fi
  case "$ref" in
    refs/lastcode/carry-sources/*) printf 'called\\n' >> "$TEST_SOURCE_MARKER" ;;
  esac
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
          reviews: [
            [
              {
                id: 1,
                user: { login: "chatgpt-codex-connector[bot]" },
                state: "APPROVED",
                commit_id: head,
                submitted_at: "2026-10-01T00:00:00Z",
              },
            ],
          ],
          reviewThreads: [
            {
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
                  },
                },
              },
            },
          ],
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
const endpoint = args.find(arg => arg.startsWith('repos/'));
let result;
if (args[0] === 'pr' && args[1] === 'merge') {
  fs.writeFileSync(process.env.TEST_MERGE_MARKER, 'called');
  cp.execFileSync('git', ['push', '--no-verify', 'origin', responses.pr.headRefOid + ':refs/heads/lastcode/main']);
  process.exit(0);
} else if (args[0] === 'pr' && args[1] === 'view') result = {...responses.pr, state: fs.existsSync(process.env.TEST_MERGE_MARKER) ? 'MERGED' : 'OPEN'};
else if (args[0] === 'api' && args[1] === 'graphql') result = responses.reviewThreads;
else if (endpoint?.endsWith('/pulls/1/reviews?per_page=100')) result = responses.reviews;
else if (endpoint?.endsWith('/comments?per_page=100')) result = [[]];
else if (args[0] === 'api' && args[1].includes('/rules/branches/')) result = responses.rules;
else if (args[0] === 'api' && args[1].includes('/runs?')) result = responses.runs;
else if (args[0] === 'api' && args[1].includes('/jobs?')) result = responses.jobs;
else if (args[0] === 'api' && args[1].endsWith('/actions/workflows/ci.yml')) result = responses.workflow;
else throw new Error('Unexpected gh command: ' + args.join(' '));
process.stdout.write(JSON.stringify(result));
`,
          { mode: 0o755 },
        );
        const node = fixtureNodeExecutable();
        const result = NodeChildProcess.spawnSync(
          node,
          [NodeURL.fileURLToPath(new URL("./lastcode-merge.ts", import.meta.url))],
          {
            cwd: repo,
            encoding: "utf8",
            env: {
              ...env,
              PATH: [bin, NodePath.dirname(node), process.env.PATH ?? ""].join(NodePath.delimiter),
              LASTCODE_GITHUB_REPOSITORY: "example/repository",
              TEST_RESPONSES: responsesPath,
              TEST_MERGE_MARKER: marker,
              TEST_LOCK_MARKER: lockMarker,
              TEST_SOURCE_MARKER: sourceMarker,
              TEST_CHECKPOINT_MARKER: checkpointMarker,
            },
          },
        );
        const compilationConflict = carryGroup === "build-ci";
        const merged = !advanceBase && !compilationConflict;
        expect(result.status, result.stderr).toBe(merged ? 0 : 1);
        if (advanceBase) expect(result.stderr).toContain(`moved from ${base} to ${advanced}`);
        else if (compilationConflict) {
          expect(result.stderr).toContain(
            `same-base carry compilation failed for ${base}..${head}`,
          );
          expect(result.stderr).toContain("could not apply");
          expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
          expect(git(repo, ["status", "--porcelain"])).toBe("");
        } else expect(result.stdout).toContain("Merge complete. No checkpoint requested.");
        expect(NodeFS.existsSync(marker)).toBe(merged);
        expect(NodeFS.existsSync(lockMarker)).toBe(!compilationConflict);
        expect(NodeFS.existsSync(sourceMarker)).toBe(Boolean(source) && merged);
        expect(NodeFS.existsSync(checkpointMarker)).toBe(false);
        expect(git(root, ["--git-dir", origin, "rev-parse", "refs/heads/lastcode/main"])).toBe(
          advanceBase ? advanced : merged ? head : base,
        );
        if (source) {
          for (const args of [[], ["--git-dir", origin]]) {
            expect(git(repo, [...args, "for-each-ref", "--format=%(objectname)", source.ref])).toBe(
              merged ? head : "",
            );
          }
        }
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
