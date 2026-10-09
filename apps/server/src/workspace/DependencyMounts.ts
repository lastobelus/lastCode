// @effect-diagnostics nodeBuiltinImport:off - Node exposes no mount-table API.
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const MAX_MOUNT_TABLE_BYTES = 1024 * 1024;

const linuxMountPoints = (table: string): ReadonlyArray<string> | null => {
  if (!table.endsWith("\n") || table.includes("\uFFFD")) return null;
  const points: string[] = [];
  for (const line of table.replace(/\n$/, "").split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    const encoded = fields[4];
    if (
      separator < 6 ||
      fields.length !== separator + 4 ||
      fields.some((field) => field === "") ||
      !/^\d+$/.test(fields[0] ?? "") ||
      !/^\d+$/.test(fields[1] ?? "") ||
      !/^\d+:\d+$/.test(fields[2] ?? "") ||
      !fields[3]?.startsWith("/") ||
      !encoded?.startsWith("/") ||
      encoded.replace(/\\(?:040|011|012|134)/g, "").includes("\\")
    )
      return null;
    points.push(
      encoded.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8)),
      ),
    );
  }
  return points.includes("/") ? points : null;
};

const darwinMountPoints = (table: string): ReadonlyArray<string> | null => {
  if (!table.endsWith("\n") || table.includes("\uFFFD")) return null;
  const points: string[] = [];
  for (const line of table.replace(/\n$/, "").split("\n")) {
    // mount prints raw names. Ambiguous delimiters or multiline names must not
    // silently hide a mounted path from this destructive operation's guard.
    if (line.split(" on ").length !== 2 || line.split(" (").length !== 2) return null;
    const match = /^.+ on (\/.*) \([a-zA-Z0-9_]+(?:, [^()\n]+)*\)$/.exec(line);
    if (!match) return null;
    points.push(match[1]!);
  }
  return points.includes("/") ? points : null;
};

const readMountPoints = async (
  platform: NodeJS.Platform,
): Promise<ReadonlyArray<string> | null> => {
  if (platform === "linux") {
    const file = await NodeFSP.open("/proc/self/mountinfo", "r");
    try {
      const buffer = Buffer.alloc(MAX_MOUNT_TABLE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) return linuxMountPoints(buffer.toString("utf8", 0, length));
        length += bytesRead;
      }
      return null;
    } finally {
      await file.close();
    }
  }
  if (platform !== "darwin") return null;
  return await new Promise((resolve) => {
    NodeChildProcess.execFile(
      "/sbin/mount",
      [],
      { timeout: 10_000, maxBuffer: MAX_MOUNT_TABLE_BYTES },
      (error, stdout, stderr) => {
        resolve(error || stderr.trim() !== "" ? null : darwinMountPoints(stdout));
      },
    );
  });
};

/** Fresh mount inventory, replaceable by isolated service tests without mounting anything. */
export class MountPoints extends Context.Reference<Effect.Effect<ReadonlyArray<string> | null>>(
  "t3/workspace/DependencyMountPoints",
  {
    defaultValue: () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        return yield* Effect.tryPromise({
          try: () => readMountPoints(platform),
          catch: () => null,
        }).pipe(Effect.catch(() => Effect.succeed(null)));
      }),
  },
) {}

export const containsMount = (root: string, points: ReadonlyArray<string>) =>
  points.some((point) => {
    const relative = NodePath.relative(root, point);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${NodePath.sep}`) &&
        !NodePath.isAbsolute(relative))
    );
  });
