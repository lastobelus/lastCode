// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Host-side CI owns these subprocesses and cancellation timers.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { runWindowsCiProcess } from "./lastcode-ci-windows.ts";

export interface CiProcessOptions {
  readonly cwd: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly failureHelp?: string;
  readonly onOutput?: (output: string) => void;
  readonly onSpawn?: (pid: number) => void;
  readonly terminationGraceMs?: number;
}

/** Waits for an owned command and its cancellation cleanup before releasing CI capacity. */
export function runCiProcess(options: CiProcessOptions): Promise<void> {
  options.signal.throwIfAborted();
  if (NodeProcess.platform === "win32") return runWindowsCiProcess(options);
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [NodePath.join(import.meta.dirname, "lastcode-ci-worker.mjs")],
      {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: options.onOutput
          ? ["ignore", "pipe", "pipe", "ipc"]
          : ["inherit", "inherit", "inherit", "ipc"],
      },
    );
    child.stdout?.on("data", (data: Buffer) => options.onOutput?.(data.toString()));
    child.stderr?.on("data", (data: Buffer) => options.onOutput?.(data.toString()));
    let closed = false;
    let cancelled = false;
    let cancellationFinished = false;
    let exitCode: number | null = null;
    let spawnError: Error | undefined;
    let cleanupError: Error | undefined;

    const finish = () => {
      if (!closed || (cancelled && !cancellationFinished)) return;
      options.signal.removeEventListener("abort", abort);
      if (spawnError) return reject(spawnError);
      if (cleanupError) return reject(cleanupError);
      if (cancelled) return reject(options.signal.reason ?? new Error("Local CI cancelled."));
      if (exitCode !== 0) {
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
      }
      resolve();
    };

    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          cleanupError = error instanceof Error ? error : new Error("CI cleanup failed.");
        }
      }
    };

    const groupStillExists = () => {
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return !(error instanceof Error && "code" in error && error.code === "ESRCH");
      }
    };

    const abort = () => {
      if (cancelled) return;
      cancelled = true;
      signalGroup("SIGTERM");
      // The launcher may exit before a resistant descendant. Keep the lease
      // until the final group signal even if the launcher's close arrived first.
      setTimeout(() => {
        signalGroup("SIGKILL");
        cancellationFinished = true;
        finish();
      }, options.terminationGraceMs ?? 2_000);
    };

    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("exit", (code) => {
      exitCode = code;
      if (!cancelled && groupStillExists()) {
        cleanupError = new Error("CI launcher exited before its owned descendants stopped.");
        abort();
      }
    });
    child.once("close", (code) => {
      closed = true;
      exitCode = code;
      finish();
    });
    options.signal.addEventListener("abort", abort, { once: true });
    if (child.pid !== undefined) {
      try {
        options.onSpawn?.(child.pid);
      } catch (error) {
        spawnError =
          error instanceof Error ? error : new Error("Could not record CI process ownership.");
        abort();
      }
    }
    if (options.signal.aborted) abort();
    if (!cancelled) {
      child.send({ command: options.command, args: [...options.args] }, (error) => {
        if (error) {
          spawnError = error;
          abort();
        }
      });
    }
  });
}
