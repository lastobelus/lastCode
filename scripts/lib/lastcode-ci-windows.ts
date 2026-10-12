// @effect-diagnostics nodeBuiltinImport:off -- Windows CI owns this exact kernel-job process and its cancellation.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as Effect from "effect/Effect";
import { resolveSpawnCommand, type ResolvedSpawnCommand } from "@t3tools/shared/shell";

import type { CiProcessOptions } from "./lastcode-ci-process.ts";

/** Serializes native argv using Windows CRT's backslash-before-quote rules. */
export function serializeWindowsNativeArguments(args: ReadonlyArray<string>) {
  return args
    .map((arg) => {
      if (arg.includes("\0"))
        throw new Error("Windows CI arguments cannot contain NUL characters.");
      return `"${arg.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\*)$/u, "$1$1")}"`;
    })
    .join(" ");
}

/** Consumes the shared resolver's already-tested .cmd/.bat escaping unchanged. */
export function buildWindowsCiLaunch(resolved: ResolvedSpawnCommand, env = NodeProcess.env) {
  if (resolved.command.includes("\0"))
    throw new Error("Windows CI commands cannot contain NUL characters.");
  if (resolved.args.some((arg) => arg.includes("\0")))
    throw new Error("Windows CI arguments cannot contain NUL characters.");
  if (!resolved.shell) {
    return {
      filePath: resolved.command,
      argumentLine: serializeWindowsNativeArguments(resolved.args),
    };
  }
  return {
    filePath: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    argumentLine: `/d /s /v:off /c "${[resolved.command, ...resolved.args].join(" ")}"`,
  };
}

/** Starts the recorded Windows job owner, which waits for the entire check tree. */
export async function runWindowsCiProcess(options: CiProcessOptions): Promise<void> {
  options.signal.throwIfAborted();
  const env = options.env ?? NodeProcess.env;
  const resolved = await Effect.runPromise(
    resolveSpawnCommand(options.command, options.args, { env }),
  );
  const payload = Buffer.from(
    JSON.stringify({ ...buildWindowsCiLaunch(resolved, env), cwd: options.cwd }),
    "utf8",
  ).toString("base64");
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        NodePath.join(import.meta.dirname, "lastcode-ci-windows.ps1"),
      ],
      {
        cwd: options.cwd,
        env,
        windowsHide: true,
        stdio: [
          "pipe",
          options.onOutput ? "pipe" : "inherit",
          options.onOutput ? "pipe" : "inherit",
        ],
      },
    );
    child.stdout?.on("data", (data: Buffer) => options.onOutput?.(data.toString()));
    child.stderr?.on("data", (data: Buffer) => options.onOutput?.(data.toString()));
    let closed = false;
    let cancelled = false;
    let terminationFinished = false;
    let exitCode: number | null = null;
    let failure: Error | undefined;
    const finish = () => {
      if (!closed || (cancelled && !terminationFinished)) return;
      options.signal.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      if (cancelled) return reject(options.signal.reason ?? new Error("Local CI cancelled."));
      if (exitCode !== 0)
        return reject(
          new Error(
            [
              `${options.command} ${options.args.join(" ")} failed with exit code ${exitCode ?? "unknown"}.`,
              options.failureHelp,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
        );
      resolve();
    };
    const cancellationFailed = (error: Error) => {
      failure ??= error;
      // Killing only the captured job owner closes its noninherited handle,
      // so Windows also terminates descendants even if taskkill is unavailable.
      child.stdin?.end();
      child.kill();
      terminationFinished = true;
      finish();
    };
    const abort = () => {
      if (cancelled) return;
      cancelled = true;
      if (child.pid === undefined) {
        terminationFinished = true;
        finish();
        return;
      }
      const killer = NodeChildProcess.spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true, env },
      );
      killer.once("error", (error) => cancellationFailed(error));
      killer.once("close", (code) => {
        if (code !== 0) {
          cancellationFailed(
            new Error(`Windows CI job termination failed with exit code ${code ?? "unknown"}.`),
          );
          return;
        }
        terminationFinished = true;
        finish();
      });
    };
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      closed = true;
      exitCode = code;
      finish();
    });
    child.stdin?.on("error", (error) => {
      if (closed || cancelled) return;
      failure = error;
      abort();
    });
    options.signal.addEventListener("abort", abort, { once: true });
    if (child.pid !== undefined) {
      try {
        options.onSpawn?.(child.pid);
      } catch (error) {
        failure =
          error instanceof Error ? error : new Error("Could not record Windows CI ownership.");
        abort();
      }
    }
    if (options.signal.aborted) abort();
    if (!cancelled && child.pid !== undefined) {
      // Keep stdin open after START. EOF is the guardian's controller-death signal.
      child.stdin?.write(`${payload}\n`, (error) => {
        if (error && !closed && !cancelled) {
          failure = error;
          abort();
        }
      });
    }
  });
}
