// @effect-diagnostics nodeBuiltinImport:off -- Host-side disposable fixtures.
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeEvents from "node:events";
import {
  parseBuildResult,
  consumeSelection,
  executeBuild,
  requestPath,
  runLocalBuild,
  selectLocalBuild,
  verifyLocalBuild,
  writeSelection,
  type LocalBuildRequest,
  type LocalBuildResult,
  type LocalBuildDeps,
} from "./lastcode-build-local-package.ts";

const tag = "lastcode/checkpoint/v1.2.3-nightly.20260904.7";
const commit = "a".repeat(40);
const request = (overrides: Partial<LocalBuildRequest> = {}): LocalBuildRequest => ({
  schemaVersion: 1,
  tag,
  commit,
  requestToken: "local-12345678-1234-1234-1234-123456789abc",
  ...overrides,
});
const buildPayload = (overrides: Partial<LocalBuildResult> = {}): LocalBuildResult => ({
  schemaVersion: 1,
  status: "built",
  checkpointTag: tag,
  outputDir: "/builds/x",
  manifestPath: "/builds/x/build-manifest.json",
  dmgPath: "/builds/x/app.dmg",
  dmgSha256: "b".repeat(64),
  ...overrides,
});

describe("local build package action", () => {
  it("selects an exact tag and records its full commit", () => {
    let saved: LocalBuildRequest | undefined;
    expect(
      selectLocalBuild(
        "/repo",
        tag,
        {
          git: () => commit,
          writeRequest: (value) => {
            saved = value;
          },
        },
        request().requestToken,
      ),
    ).toEqual(request());
    expect(saved).toEqual(request());
  });
  it("rejects moving or invalid selectors and parses the helper result", () => {
    expect(() =>
      selectLocalBuild("/repo", "latest", { git: () => commit, writeRequest: () => {} }),
    ).toThrow("exact");
    expect(() => parseBuildResult("noise\n")).toThrow("did not return");
    expect(() =>
      parseBuildResult(
        `LASTCODE_LOCAL_UPDATE_RESULT=${JSON.stringify(buildPayload())}\nLASTCODE_LOCAL_UPDATE_RESULT=${JSON.stringify(buildPayload())}`,
      ),
    ).toThrow("exactly one");
    expect(
      parseBuildResult(`LASTCODE_LOCAL_UPDATE_RESULT=${JSON.stringify(buildPayload())}`),
    ).toMatchObject({ checkpointTag: tag });
  });
  it("writes and consumes one selection, requiring reselection", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "local-build-selection-"));
    onTestFinished(() => NodeFS.rmSync(root, { recursive: true, force: true }));
    const path = NodePath.join(root, "git", "lastcode-actions", "build.json");
    writeSelection(path, request());
    expect(consumeSelection(path)).toEqual(request());
    expect(() => consumeSelection(path)).toThrow("each selection permits one attempt");
    writeSelection(path, request({ requestToken: "local-aaaaaaaa-1234-1234-1234-123456789abc" }));
    expect(consumeSelection(path).requestToken).toContain("local-aaaaaaaa");
    NodeFS.writeFileSync(path, JSON.stringify({ ...request(), commit: "not-a-commit" }));
    expect(() => consumeSelection(path)).toThrow("invalid");
    expect(requestPath(root, () => "git/lastcode-actions/build.json")).toBe(
      NodePath.join(root, "git/lastcode-actions/build.json"),
    );
  });
  it("verifies a complete helper artifact and rejects missing DMGs or wrong commits", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "local-build-artifact-"));
    onTestFinished(() => NodeFS.rmSync(root, { recursive: true, force: true }));
    const git = (args: string[]) =>
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
        { cwd: root, encoding: "utf8" },
      ).trim();
    git(["init", "-q"]);
    NodeFS.writeFileSync(NodePath.join(root, "source"), "source\n");
    git(["add", "."]);
    git(["commit", "-qm", "source"]);
    const commit = git(["rev-parse", "HEAD"]);
    const tagName = "lastcode/build/v1.2.3-nightly.20260904.7.1";
    git(["tag", "-a", tagName, "-m", "build"]);
    const output = NodePath.join(
      root,
      ".lastcode",
      "local-updates",
      "artifacts",
      "v1.2.3-nightly.20260904.7",
      commit.slice(0, 10),
    );
    NodeFS.mkdirSync(output, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(output, "nightly-mac.yml"), "fixture\n");
    NodeFS.writeFileSync(NodePath.join(output, "SHA256SUMS"), "fixture\n");
    NodeFS.writeFileSync(NodePath.join(output, "LastCode.dmg"), "dmg\n");
    NodeFS.writeFileSync(NodePath.join(output, "LastCode.zip"), "zip\n");
    const sha = "b".repeat(64);
    NodeFS.writeFileSync(
      NodePath.join(output, "build-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        checkpointTag: tag,
        lastCodeCommit: commit,
        buildTag: tagName,
        artifacts: [{ path: "LastCode.dmg", sha256: sha }],
      }),
    );
    const req = request({ tag, commit });
    const result = buildPayload({
      checkpointTag: tag,
      outputDir: output,
      manifestPath: NodePath.join(output, "build-manifest.json"),
      dmgPath: NodePath.join(output, "LastCode.dmg"),
      dmgSha256: sha,
    });
    expect(() => verifyLocalBuild(result, req, root, root)).not.toThrow();
    expect(() => verifyLocalBuild(result, request({ commit: "c".repeat(40) }), root, root)).toThrow(
      "complete verified",
    );
    NodeFS.rmSync(NodePath.join(output, "LastCode.dmg"));
    expect(() => verifyLocalBuild(result, req, root, root)).toThrow("complete");
  });
  it("runs the canonical helper and verifies the selected target before and after", async () => {
    const calls: string[][] = [];
    const build = await runLocalBuild("/repo", {
      git: () => commit,
      readRequest: () => request(),
      writeRequest: () => {},
      execute: (_command, args) => {
        calls.push([...args]);
        return {
          code: 0,
          stdout: `LASTCODE_LOCAL_UPDATE_RESULT=${JSON.stringify(buildPayload())}`,
          stderr: "",
        };
      },
      verifyResult: () => {},
    });
    expect(build.outputDir).toBe("/builds/x");
    expect(calls[0]?.some((value) => value.endsWith("/scripts/lastcode-local-update.mjs"))).toBe(
      true,
    );
    expect(calls[0]).toContain("--checkpoint");
  });
  it("turns child failures and mismatched results into actionable errors", async () => {
    await expect(
      runLocalBuild("/repo", {
        git: () => commit,
        readRequest: () => request(),
        writeRequest: () => {},
        execute: () => ({ code: 1, stdout: "", stderr: "compiler failed" }),
        verifyResult: () => {},
      }),
    ).rejects.toThrow("compiler failed");
    await expect(
      runLocalBuild("/repo", {
        git: () => commit,
        readRequest: () => request(),
        writeRequest: () => {},
        execute: () => ({
          code: 0,
          stdout: `LASTCODE_LOCAL_UPDATE_RESULT=${JSON.stringify(buildPayload({ checkpointTag: "other" }))}`,
          stderr: "",
        }),
        verifyResult: () => {},
      }),
    ).rejects.toThrow("expected");
  });
  it("bounds captured stdout and stderr from the owned child", async () => {
    const result = await executeBuild(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(100000));"],
      process.cwd(),
    );
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.stderr.length).toBeLessThanOrEqual(64 * 1024);
  });
  it("rejects a moved target before execution and after successful helper completion", async () => {
    let executions = 0;
    const deps: LocalBuildDeps = {
      git: () => "b".repeat(40),
      readRequest: () => request(),
      writeRequest: () => {},
      execute: () => {
        executions++;
        return {
          code: 0,
          stdout: `LASTCODE_LOCAL_UPDATE_RESULT=${JSON.stringify(buildPayload())}`,
          stderr: "",
        };
      },
      verifyResult: () => {},
    };
    await expect(runLocalBuild("/repo", deps)).rejects.toThrow("moved");
    expect(executions).toBe(0);
    let resolutions = 0;
    await expect(
      runLocalBuild("/repo", {
        ...deps,
        git: () => (resolutions++ === 0 ? commit : "b".repeat(40)),
      }),
    ).rejects.toThrow("changed during");
    expect(executions).toBe(1);
  });

  it("cancels its owned child when aborted after a readiness receipt", async () => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1");
    await NodeEvents.once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const controller = new AbortController();
    const connected = NodeEvents.once(server, "connection");
    const running = executeBuild(
      process.execPath,
      ["-e", `require('node:net').connect(${address.port}, '127.0.0.1');`],
      process.cwd(),
      controller.signal,
    );
    const rejection = expect(running).rejects.toThrow("fixture cancelled");
    try {
      const [socket] = await connected;
      const closed = NodeEvents.once(socket, "close");
      controller.abort(new Error("fixture cancelled"));
      await rejection;
      await closed;
    } finally {
      controller.abort(new Error("fixture cancelled"));
      server.close();
      await NodeEvents.once(server, "close");
    }
  });
});
