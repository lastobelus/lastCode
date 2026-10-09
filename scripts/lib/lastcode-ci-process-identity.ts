// @effect-diagnostics nodeBuiltinImport:off -- Admission reads only targeted OS process identities.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";

type ProcessIdentity = {
  readonly startIdentity: string;
  readonly group: number | null;
};

let currentStartIdentity: string | undefined;
let bootIdentity: string | undefined;

export function isProcessRunning(pid: number) {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    // Permissions or an unsupported probe do not establish that ownership ended.
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

/** Missing entries mean identity is unknown, never evidence that a process exited. */
export function readProcessIdentities(requestedPids: readonly number[]) {
  const pids = [...new Set(requestedPids)];
  const identities = new Map<number, ProcessIdentity>();
  if (pids.length === 0) return identities;
  if (NodeProcess.platform === "linux") {
    try {
      bootIdentity ??= NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      return identities;
    }
    for (const pid of pids) {
      try {
        const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
        // The command field can contain spaces and parentheses; fields after it
        // begin at state (3), making pgrp (5) index 2 and starttime (22) index 19.
        const fields = stat
          .slice(stat.lastIndexOf(")") + 1)
          .trim()
          .split(/\s+/u);
        const start = fields[19];
        const group = Number(fields[2]);
        if (
          start !== undefined &&
          /^\d+$/u.test(start) &&
          Number.isSafeInteger(group) &&
          group > 0
        ) {
          identities.set(pid, { startIdentity: `linux:${bootIdentity}:${start}`, group });
        }
      } catch {
        // Exit races and inaccessible process metadata remain conservative.
      }
    }
    return identities;
  }

  const windows = NodeProcess.platform === "win32";
  const command = windows ? "powershell.exe" : "/bin/ps";
  const args = windows
    ? [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `foreach ($requestedId in @(${pids.join(",")})) { try { $p = [System.Diagnostics.Process]::GetProcessById($requestedId); Write-Output ("{0} {1}" -f $requestedId, $p.StartTime.ToUniversalTime().Ticks); $p.Dispose() } catch {} }`,
      ]
    : ["-p", pids.join(","), "-o", "pid=,pgid=,lstart="];
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
    windowsHide: true,
    // ps must produce the same start identity across locales and time zones.
    ...(windows ? {} : { env: { LC_ALL: "C", TZ: "UTC" } }),
  });
  if (result.error !== undefined) return identities;
  for (const line of (result.stdout ?? "").split("\n")) {
    const match = windows
      ? /^\s*(\d+)\s+(\d+)\s*$/u.exec(line)
      : /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (!pids.includes(pid)) continue;
    identities.set(pid, {
      startIdentity: windows ? `win32:${match[2]}` : `posix:${match[3]}`,
      group: windows ? null : Number(match[2]),
    });
  }
  return identities;
}

export function getCurrentProcessStartIdentity() {
  currentStartIdentity ??= readProcessIdentities([NodeProcess.pid]).get(
    NodeProcess.pid,
  )?.startIdentity;
  if (currentStartIdentity === undefined) {
    throw new Error(
      "Unable to establish this process's local CI ownership identity. Admission has stopped.",
    );
  }
  return currentStartIdentity;
}

export function isProcessIdentityRunning(
  pid: number,
  startIdentity: string | null,
  identities: ReadonlyMap<number, ProcessIdentity>,
) {
  if (!isProcessRunning(pid)) return false;
  const actual = identities.get(pid);
  return startIdentity === null || actual === undefined || actual.startIdentity === startIdentity;
}
