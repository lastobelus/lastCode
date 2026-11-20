// @effect-diagnostics nodeBuiltinImport:off -- Recovery guards use a disposable Git repository.
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { regenerateCheckpointLockfile } from "./lastcode-regenerate-derived.ts";

it("reads large upstream lockfiles and leaves retained data untouched until preflight passes", async () => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-derived-"));
  try {
    NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd });
    const lockfile = NodePath.join(cwd, "pnpm-lock.yaml");
    NodeFS.writeFileSync(lockfile, "retained lockfile");
    NodeFS.mkdirSync(NodePath.join(cwd, ".git", "rebase-merge"));
    await expect(regenerateCheckpointLockfile("HEAD", cwd)).rejects.toThrow(/Finish the replay/);
    expect(NodeFS.readFileSync(lockfile, "utf8")).toBe("retained lockfile");
    NodeFS.rmdirSync(NodePath.join(cwd, ".git", "rebase-merge"));
    await expect(regenerateCheckpointLockfile("missing-upstream", cwd)).rejects.toThrow();
    expect(NodeFS.readFileSync(lockfile, "utf8")).toBe("retained lockfile");
    NodeFS.writeFileSync(
      NodePath.join(cwd, "package.json"),
      JSON.stringify({ packageManager: "pnpm@12.15.0" }),
    );
    NodeFS.writeFileSync(lockfile, "upstream lockfile\n" + "x".repeat(1024 * 1024));
    const git = (...args: string[]) => NodeChildProcess.execFileSync("git", args, { cwd });
    git("add", "package.json", "pnpm-lock.yaml");
    git(
      "-c",
      "commit.gpgSign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    NodeFS.writeFileSync(lockfile, "retained lockfile");
    const bin = NodePath.join(cwd, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(NodePath.join(bin, "pnpm"), "#!/bin/sh\nprintf '0.0.0\\n'\n", {
      mode: 0o755,
    });
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("./lastcode-regenerate-derived.ts", import.meta.url)),
        "--upstream",
        "HEAD",
      ],
      { cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires pnpm@12.15.0");
    expect(NodeFS.readFileSync(lockfile, "utf8")).toBe("retained lockfile");
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});
