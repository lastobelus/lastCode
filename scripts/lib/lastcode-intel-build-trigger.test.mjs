import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { triggerIntelBuild } from "./lastcode-intel-build-trigger.mjs";
import { completeLocalBuild } from "../lastcode-local-update.mjs";

const tag = "lastcode/checkpoint/v1.2.3-nightly.20260904.7";
const commit = "a".repeat(40);
function fixture(config = { schemaVersion: 1, enabled: true }) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "intel-trigger-"));
  onTestFinished(() => NodeFS.rmSync(home, { recursive: true, force: true }));
  if (config) {
    const directory = NodePath.join(home, ".lastcode", "automation");
    NodeFS.mkdirSync(directory, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(directory, "intel-build-trigger.json"),
      JSON.stringify(config),
    );
  }
  return { home, repoRoot: home, tag, commit };
}
function commands(input, runs = []) {
  const calls = [];
  const runCommand = (_root, command, args) => {
    calls.push({ command, args });
    if (command === "git") return `${input.commit}\trefs/tags/${input.tag}^{}`;
    if (args[0] === "run") return JSON.stringify(runs);
    return "";
  };
  return { calls, runCommand };
}

describe("Intel dispatch after verified local packaging", () => {
  it.each([null, { schemaVersion: 1, enabled: false }])(
    "does nothing when opt-in is absent or disabled: %j",
    (config) => {
      const input = fixture(config);
      const deps = commands(input);
      expect(triggerIntelBuild(input, deps).status).toBe(config ? "disabled" : "not-configured");
      expect(deps.calls).toEqual([]);
    },
  );

  it("dispatches the verified exact target outside the daily schedule", () => {
    const input = fixture();
    const deps = commands(input);
    const artifact = {
      outputDir: "/build",
      manifestPath: "/build/build-manifest.json",
      dmgPath: "/build/app.dmg",
      dmgSha256: "b".repeat(64),
    };
    const result = completeLocalBuild({ ...input, checkpointTag: tag }, commit, artifact, deps);
    expect(result).toMatchObject({
      status: "built",
      ...artifact,
      intelTrigger: { status: "dispatched", tag, commit },
    });
    expect(deps.calls.at(-1)).toMatchObject({
      command: "gh",
      args: [
        "workflow",
        "run",
        "lastcode-daily-intel-package.yml",
        "--repo",
        "lastobelus/lastCode",
        "--ref",
        "lastcode/main",
        "--field",
        `installable_tag=${tag}`,
        "--field",
        `installable_commit=${commit}`,
      ],
    });
  });

  it("reuses an active exact target while ignoring newer or completed dispatches", () => {
    const input = fixture();
    const title = `Ensure Intel package · ${tag} · ${commit}`;
    const deps = commands(input, [
      {
        displayTitle: title,
        status: "completed",
        databaseId: 1,
        url: "https://example.invalid/runs/1",
      },
      { displayTitle: `${title}different`, status: "in_progress", databaseId: 2 },
      {
        displayTitle: title,
        status: "queued",
        databaseId: 3,
        url: "https://example.invalid/runs/3",
      },
    ]);
    expect(triggerIntelBuild(input, deps)).toMatchObject({
      status: "running",
      tag,
      commit,
      runId: 3,
      runUrl: "https://example.invalid/runs/3",
    });
    expect(deps.calls).toHaveLength(2);
  });

  it("reports dispatch failure while leaving the local package built", () => {
    const input = fixture();
    const deps = commands(input);
    const result = completeLocalBuild(
      { ...input, checkpointTag: tag },
      commit,
      { outputDir: "/build" },
      {
        runCommand: (root, command, args) => {
          if (args[0] === "workflow") throw new Error("GitHub unavailable");
          return deps.runCommand(root, command, args);
        },
      },
    );
    expect(result).toMatchObject({
      status: "built",
      outputDir: "/build",
      intelTrigger: { status: "failed", error: "GitHub unavailable" },
    });
  });

  it("refuses an unpublished or changed tag before querying or dispatching GitHub", () => {
    const input = fixture();
    const calls = [];
    expect(
      triggerIntelBuild(input, {
        runCommand: (_root, command) => {
          calls.push(command);
          return `${"b".repeat(40)}\trefs/tags/${tag}`;
        },
      }),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("does not match verified local commit"),
    });
    expect(calls).toEqual(["git"]);
  });

  it.each([false, true])(
    "cached artifact reuse triggers hosted work; failed build does not (failure: %s)",
    (failure) => {
      const input = fixture();
      const git = (...args) =>
        NodeChildProcess.execFileSync(
          "git",
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "tag.gpgsign=false",
            ...args,
          ],
          { cwd: input.home, encoding: "utf8" },
        ).trim();
      git("init", "-q");
      NodeFS.writeFileSync(NodePath.join(input.home, "source"), "fixture");
      git("add", "source");
      git("commit", "-qm", "fixture");
      const exactCommit = git("rev-parse", "HEAD");
      if (!failure) git("tag", "-a", tag, "-m", "installable");
      git("remote", "add", "origin", input.home);
      const buildTag = "lastcode/build/v1.2.3-nightly.20260904.7.1";
      git("tag", "-a", buildTag, "-m", "build");
      const output = NodePath.join(
        input.home,
        ".lastcode",
        "local-updates",
        "artifacts",
        "v1.2.3-nightly.20260904.7",
        exactCommit.slice(0, 10),
      );
      NodeFS.mkdirSync(output, { recursive: true });
      for (const name of ["LastCode.dmg", "LastCode.zip", "nightly-mac.yml", "SHA256SUMS"])
        NodeFS.writeFileSync(NodePath.join(output, name), "fixture");
      NodeFS.writeFileSync(
        NodePath.join(output, "build-manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          checkpointTag: tag,
          lastCodeCommit: exactCommit,
          buildTag,
          artifacts: [
            {
              path: "LastCode.dmg",
              sha256: NodeCrypto.createHash("sha256").update("fixture").digest("hex"),
            },
          ],
        }),
      );
      const bin = NodePath.join(input.home, "fake-bin");
      NodeFS.mkdirSync(bin);
      const log = NodePath.join(input.home, "gh-calls.jsonl");
      NodeFS.writeFileSync(
        NodePath.join(bin, "gh"),
        `#!${process.execPath}\nconst fs = require("node:fs"); fs.appendFileSync(process.env.LASTCODE_TEST_GH_LOG, JSON.stringify(process.argv.slice(2)) + "\\n"); if (process.argv[2] === "run") process.stdout.write("[]");\n`,
        { mode: 0o755 },
      );
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [
          NodePath.resolve(import.meta.dirname, "../lastcode-local-update.mjs"),
          "build",
          "--repo",
          input.home,
          "--home",
          input.home,
          "--checkpoint",
          tag,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            LASTCODE_TEST_GH_LOG: log,
            PATH: `${bin}${NodePath.delimiter}${process.env.PATH}`,
          },
          timeout: 10_000,
        },
      );
      if (failure) {
        expect(result.status).toBe(1);
        expect(NodeFS.existsSync(log)).toBe(false);
      } else {
        expect(result.status, result.stderr).toBe(0);
        const payload = JSON.parse(
          result.stdout.trim().replace("LASTCODE_LOCAL_UPDATE_RESULT=", ""),
        );
        expect(payload).toMatchObject({
          status: "built",
          intelTrigger: { status: "dispatched", tag, commit: exactCommit },
        });
        const calls = NodeFS.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
        expect(calls.at(-1)).toContain(`installable_tag=${tag}`);
        expect(calls.at(-1)).toContain(`installable_commit=${exactCommit}`);
      }
    },
  );
});
