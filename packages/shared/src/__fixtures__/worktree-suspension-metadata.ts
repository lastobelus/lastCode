// @effect-diagnostics nodeBuiltinImport:off -- Test fixtures must intercept the native subprocess metadata checks.
import type * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as HostProcess from "../HostProcess.ts";

// macOS can reapply provenance even after deletion. Normalize only its listing in
// owned fixtures; real commands, errors, and every other metadata check still run.
export const fixtureMetadataExecFile = (
  root: string,
  original: typeof NodeChildProcess.execFile,
): typeof NodeChildProcess.execFile =>
  ((...parameters: Parameters<typeof NodeChildProcess.execFile>) => {
    const [program, args, options, callback] = parameters;
    const target = args?.[1];
    if (
      HostProcess.Platform.defaultValue() !== "darwin" ||
      program !== "/usr/bin/xattr" ||
      args?.length !== 2 ||
      (args[0] !== "-s" && args[0] !== "-rs") ||
      target === undefined ||
      target !== NodePath.resolve(target) ||
      (target !== root && !target.startsWith(`${root}${NodePath.sep}`)) ||
      callback == null
    )
      return original(...parameters);
    return original(program, args, options, (error, stdout, stderr) => {
      if (error !== null || !Buffer.isBuffer(stdout)) return callback(error, stdout, stderr);
      const text = stdout.toString("utf8");
      if (!Buffer.from(text).equals(stdout)) return callback(error, stdout, stderr);
      const normalized = text
        .split("\n")
        .filter((line) => {
          if (args[0] === "-s") return line !== "com.apple.provenance";
          const suffix = ": com.apple.provenance";
          if (!line.endsWith(suffix)) return true;
          const path = line.slice(0, -suffix.length);
          return path !== target && !path.startsWith(`${target}${NodePath.sep}`);
        })
        .join("\n");
      callback(error, Buffer.from(normalized), stderr);
    });
  }) as typeof NodeChildProcess.execFile;
