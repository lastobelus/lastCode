#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Dependency-free worktree preparation.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { lastCodeAction as defaultActionReporter } from "./lib/lastcode-action-kit.ts";

/** Install the target checkout's locked dependency graph without a separate readiness stamp. */
export function prepareDependencies(cwd: string, execute = NodeChildProcess.spawnSync) {
  const target = NodePath.resolve(cwd);
  const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(target, "package.json"), "utf8"));
  const pin =
    typeof manifest.packageManager === "string"
      ? manifest.packageManager.match(
          /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)(?:\+sha(?:224|512)\.[0-9a-f]+)?$/,
        )
      : null;
  if (!pin) {
    throw new Error("Expected an exact pnpm version in the target checkout's package.json.");
  }
  const packageManager = `pnpm@${pin[1]}`;
  if (!NodeFS.existsSync(NodePath.join(target, "pnpm-lock.yaml"))) {
    throw new Error("The target checkout has no pnpm-lock.yaml.");
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This bootstrap must run without installed workspace dependencies.
  const options = { cwd: target, shell: process.platform === "win32" };
  const version = execute("pnpm", ["--version"], { ...options, encoding: "utf8" });
  if (version.error || version.status !== 0) {
    throw new Error(`Dependency installer unavailable. Install ${packageManager} and retry.`);
  }
  if (String(version.stdout).trim() !== pin[1]) {
    throw new Error(
      `Dependency preparation requires ${packageManager}; found ${String(version.stdout).trim()}.`,
    );
  }
  const installed = execute("pnpm", ["install", "--frozen-lockfile"], {
    ...options,
    stdio: "inherit",
  });
  if (installed.error) throw installed.error;
  if (installed.status !== 0) {
    throw new Error(
      `Dependency installation failed (${installed.signal ?? installed.status ?? "unknown exit"}).`,
    );
  }
}

export function runPreparation(
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
  prepare = prepareDependencies,
  lastCodeAction = defaultActionReporter,
) {
  try {
    if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--for-ci")) {
      throw new Error("Usage: prepare-dependencies.ts [--for-ci] (run in the target checkout)");
    }
    lastCodeAction.progress({
      state: "working",
      phase: "dependencies",
      summary: "Preparing checkout dependencies",
    });
    prepare(cwd);
    // CI follows in the same Action and owns its successful terminal result.
    if (argv[0] !== "--for-ci") {
      lastCodeAction.result({
        outcome: "success",
        reason: "dependencies-installed",
        summary: "Dependency installation completed",
      });
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[prepare-dependencies] ${message}`);
    lastCodeAction.result({
      outcome: "attention",
      reason: "dependency-preparation-failed",
      summary: message.slice(0, 280),
    });
    return 1;
  }
}

if (import.meta.main) process.exitCode = runPreparation(process.argv.slice(2));
