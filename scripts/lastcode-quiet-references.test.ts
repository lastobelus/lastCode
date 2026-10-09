// @effect-diagnostics nodeBuiltinImport:off -- This test builds disposable Git repositories.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  normalizeCheckpointCommits,
  normalizeCheckpointMessage,
} from "./lastcode-quiet-references.ts";

const repositories: Array<string> = [];

function git(cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitRaw(cwd: string, args: ReadonlyArray<string>): Buffer {
  return NodeChildProcess.execFileSync("git", args, { cwd });
}

function repository(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-quiet-references-"));
  repositories.push(root);
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Quiet checkpoint test"]);
  git(root, ["config", "user.email", "quiet-checkpoint@example.invalid"]);
  git(root, ["config", "core.hooksPath", "/dev/null"]);
  git(root, ["config", "commit.gpgSign", "false"]);
  return root;
}

function commit(
  cwd: string,
  message: string,
  environment: Readonly<Record<string, string>> = {},
): string {
  git(cwd, ["add", "--all"]);
  NodeChildProcess.execFileSync("git", ["commit", "--quiet", "--message", message], {
    cwd,
    env: { ...process.env, ...environment },
    encoding: "utf8",
  });
  return git(cwd, ["rev-parse", "HEAD"]);
}

afterEach(() => {
  for (const repositoryPath of repositories.splice(0)) {
    NodeFS.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

describe("normalizeCheckpointMessage", () => {
  it("quiets upstream URLs and qualified references while preserving local and already quiet references", () => {
    expect(
      normalizeCheckpointMessage(
        [
          "pull https://github.com/example/upstream/pull/42?view=files#discussion",
          "issue http://www.github.com/example/upstream/issues/7#note",
          "qualified example/upstream#43",
          "local lastobelus/lastCode#9",
          "local URL https://github.com/lastobelus/lastCode/pull/10",
          "canonical https://github.com/example/upstream",
          "bare #11 sha 0123456789abcdef0123456789abcdef01234567",
          "quiet https://redirect.github.com/example/upstream/pull/42",
          "bad https://github.com.evil.example/example/upstream/pull/44",
          "embedded https://example.test/github.com/example/upstream/pull/45",
        ].join("\n"),
      ),
    ).toBe(
      [
        "pull https://redirect.github.com/example/upstream/pull/42?view=files#discussion",
        "issue https://redirect.github.com/example/upstream/issues/7#note",
        "qualified https://redirect.github.com/example/upstream/issues/43",
        "local lastobelus/lastCode#9",
        "local URL https://github.com/lastobelus/lastCode/pull/10",
        "canonical https://github.com/example/upstream",
        "bare #11 sha 0123456789abcdef0123456789abcdef01234567",
        "quiet https://redirect.github.com/example/upstream/pull/42",
        "bad https://github.com.evil.example/example/upstream/pull/44",
        "embedded https://example.test/github.com/example/upstream/pull/45",
      ].join("\n"),
    );
  });

  it("keeps carry metadata valid JSON and leaves its identifiers unchanged", () => {
    const metadata = {
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      sourceRef: "refs/heads/lastcode/main",
      upstream: "example/upstream#12",
    };
    const normalized = normalizeCheckpointMessage(JSON.stringify(metadata));
    expect(JSON.parse(normalized)).toEqual({
      ...metadata,
      upstream: "https://redirect.github.com/example/upstream/issues/12",
    });
  });
});

describe("normalizeCheckpointCommits", () => {
  it("rewrites only a linear downstream range and preserves trees, identities, and refs", () => {
    const repo = repository();
    NodeFS.writeFileSync(NodePath.join(repo, "base.txt"), "base\n");
    const base = commit(repo, "upstream base https://github.com/example/upstream/pull/1");
    NodeFS.writeFileSync(NodePath.join(repo, "source.txt"), "source\n");
    const source = commit(repo, "source https://github.com/example/upstream/pull/42", {
      GIT_AUTHOR_NAME: "Original Author",
      GIT_AUTHOR_EMAIL: "author@example.invalid",
      GIT_AUTHOR_DATE: "2024-01-02T03:04:05-0700",
      GIT_COMMITTER_NAME: "Original Committer",
      GIT_COMMITTER_EMAIL: "committer@example.invalid",
      GIT_COMMITTER_DATE: "2024-02-03T04:05:06-0700",
    });
    NodeFS.writeFileSync(NodePath.join(repo, "tail.txt"), "tail\n");
    const head = commit(repo, "unchanged downstream tail");
    git(repo, ["tag", "source-tag", source]);
    git(repo, ["branch", "source-ref", source]);
    const beforeWorktree = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const expectedRawBase = gitRaw(repo, ["cat-file", "commit", base]);
    const expectedTrees = new Map(
      [base, source, head].map((commitSha) => [
        commitSha,
        git(repo, ["rev-parse", `${commitSha}^{tree}`]),
      ]),
    );
    const expectedIdentity = git(repo, [
      "show",
      "-s",
      "--format=%an%n%ae%n%ad%n%cn%n%ce%n%cd",
      source,
    ]);

    const normalizedHead = normalizeCheckpointCommits(repo, base);
    expect(normalizedHead).not.toBe(head);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(normalizedHead);
    expect(git(repo, ["rev-parse", "source-tag"])).toBe(source);
    expect(git(repo, ["rev-parse", "source-ref"])).toBe(source);
    expect(gitRaw(repo, ["cat-file", "commit", base])).toEqual(expectedRawBase);
    expect(git(repo, ["show", "-s", "--format=%B", normalizedHead])).toBe(
      "unchanged downstream tail",
    );
    expect(git(repo, ["show", "-s", "--format=%B", `${normalizedHead}^`])).toContain(
      "https://redirect.github.com/example/upstream/pull/42",
    );
    expect(
      git(repo, ["show", "-s", "--format=%an%n%ae%n%ad%n%cn%n%ce%n%cd", `${normalizedHead}^`]),
    ).toBe(expectedIdentity);
    expect(git(repo, ["rev-parse", `${normalizedHead}^{tree}`])).toBe(expectedTrees.get(head));
    expect(git(repo, ["rev-parse", `${normalizedHead}~1^{tree}`])).toBe(expectedTrees.get(source));
    expect(git(repo, ["rev-parse", `${normalizedHead}~2^{tree}`])).toBe(expectedTrees.get(base));
    expect(git(repo, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(beforeWorktree);
    expect(normalizeCheckpointCommits(repo, base)).toBe(normalizedHead);
  });

  it("removes invalidated signatures without changing other bytes or the signed source", () => {
    const repo = repository();
    NodeFS.writeFileSync(NodePath.join(repo, "base.txt"), "base\n");
    const base = commit(repo, "base");
    NodeFS.writeFileSync(NodePath.join(repo, "source.txt"), "source\n");
    const source = commit(repo, "Upstream: example/upstream#42");
    const unsigned = `${gitRaw(repo, ["cat-file", "commit", source]).toString("utf8")}\n\n`;
    const signed = unsigned.replace(
      "\n\n",
      "\ngpgsig -----BEGIN PGP SIGNATURE-----\n fixture\n -----END PGP SIGNATURE-----\n\n",
    );
    const signedHead = NodeChildProcess.execFileSync(
      "git",
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      { cwd: repo, input: signed, encoding: "utf8" },
    ).trim();
    git(repo, ["update-ref", "HEAD", signedHead, source]);
    git(repo, ["tag", "signed-source", signedHead]);
    const normalized = normalizeCheckpointCommits(repo, base);
    expect(gitRaw(repo, ["cat-file", "commit", normalized]).toString("utf8")).toBe(
      normalizeCheckpointMessage(unsigned),
    );
    expect(gitRaw(repo, ["cat-file", "commit", "signed-source"]).toString("utf8")).toBe(signed);
  });

  it("rejects dirty worktrees and preserves merge topology in generated repairs", () => {
    const repo = repository();
    NodeFS.writeFileSync(NodePath.join(repo, "base.txt"), "base\n");
    const base = commit(repo, "base");
    NodeFS.writeFileSync(NodePath.join(repo, "dirty.txt"), "dirty\n");
    const cleanHead = git(repo, ["rev-parse", "HEAD"]);
    expect(() => normalizeCheckpointCommits(repo, base)).toThrow();
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(cleanHead);
    git(repo, ["add", "dirty.txt"]);
    const main = commit(repo, "main line");
    git(repo, ["checkout", "--quiet", "-b", "side", base]);
    NodeFS.writeFileSync(NodePath.join(repo, "side.txt"), "side\n");
    const side = commit(repo, "side line https://github.com/example/upstream/pull/42");
    git(repo, ["checkout", "--quiet", "main"]);
    git(repo, ["merge", "--quiet", "--no-ff", "side", "--message", "merge line"]);
    const nonlinearHead = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["tag", "--annotate", "side-tag", side, "--message", "source tag"]);
    const mergeTag = git(repo, ["cat-file", "tag", "side-tag"]).replaceAll("\n", "\n ");
    const taggedMerge = NodeChildProcess.execFileSync(
      "git",
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      {
        cwd: repo,
        encoding: "utf8",
        input: gitRaw(repo, ["cat-file", "commit", nonlinearHead])
          .toString("utf8")
          .replace("\n\n", `\nmergetag ${mergeTag}\n\n`),
      },
    ).trim();
    git(repo, ["update-ref", "HEAD", taggedMerge, nonlinearHead]);
    const normalized = normalizeCheckpointCommits(repo, base);
    const parents = git(repo, ["show", "-s", "--format=%P", normalized]).split(" ");
    expect(parents).toHaveLength(2);
    expect(parents[0]).toBe(main);
    expect(parents[1]).not.toBe(side);
    expect(git(repo, ["show", "-s", "--format=%P", parents[1]!])).toBe(base);
    expect(git(repo, ["show", "-s", "--format=%B", parents[1]!])).toContain(
      "https://redirect.github.com/example/upstream/pull/42",
    );
    expect(git(repo, ["rev-parse", `${normalized}^{tree}`])).toBe(
      git(repo, ["rev-parse", `${nonlinearHead}^{tree}`]),
    );
    expect(gitRaw(repo, ["cat-file", "commit", normalized]).toString("utf8")).not.toContain(
      "\nmergetag ",
    );
    expect(git(repo, ["rev-parse", "side-tag^{commit}"])).toBe(side);
    expect(normalizeCheckpointCommits(repo, base)).toBe(normalized);
  });

  it("rejects a base that is outside the current history", () => {
    const repo = repository();
    NodeFS.writeFileSync(NodePath.join(repo, "base.txt"), "base\n");
    const first = commit(repo, "first history");
    git(repo, ["checkout", "--quiet", "--orphan", "unrelated"]);
    git(repo, ["rm", "--quiet", "--cached", "-r", "."]);
    NodeFS.writeFileSync(NodePath.join(repo, "other.txt"), "other\n");
    commit(repo, "unrelated history");
    const head = git(repo, ["rev-parse", "HEAD"]);
    expect(() => normalizeCheckpointCommits(repo, first)).toThrow();
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
  });
});
