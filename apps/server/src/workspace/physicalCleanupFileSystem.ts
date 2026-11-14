import { isElectron, promises as NodeFSP } from "@t3tools/shared/nativeFileSystem";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

type CleanupFileSystem = Pick<
  FileSystem.FileSystem,
  | "exists"
  | "lstat"
  | "makeDirectory"
  | "readDirectory"
  | "readFileString"
  | "readLink"
  | "realPath"
  | "remove"
  | "rename"
  | "stat"
  | "writeFileString"
>;

const reasons: Readonly<Record<string, PlatformError.SystemErrorTag>> = {
  ENOENT: "NotFound",
  EACCES: "PermissionDenied",
  EPERM: "PermissionDenied",
  EEXIST: "AlreadyExists",
  EISDIR: "BadResource",
  ENOTDIR: "BadResource",
  ELOOP: "BadResource",
  EBUSY: "Busy",
};

// The enclosing cleanup operation traces these per-file calls.
const native = <A>(method: string, path: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      PlatformError.systemError({
        module: "FileSystem",
        method,
        pathOrDescriptor: path,
        _tag: reasons[(cause as NodeJS.ErrnoException).code ?? ""] ?? "Unknown",
        cause,
      }),
  });

const number = (value: bigint) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new RangeError("Filesystem value exceeds safe integer range");
  return result;
};
const optionalNumber = (value: bigint | undefined) =>
  value !== undefined && Number.isSafeInteger(Number(value))
    ? Option.some(Number(value))
    : Option.none();

const physicalStat = (method: "stat" | "lstat") => (path: string) =>
  native(method, path, () => NodeFSP[method](path, { bigint: true })).pipe(
    Effect.flatMap((stat) =>
      Effect.try({
        try: (): FileSystem.File.Info => ({
          type: stat.isFile()
            ? "File"
            : stat.isDirectory()
              ? "Directory"
              : stat.isSymbolicLink()
                ? "SymbolicLink"
                : stat.isBlockDevice()
                  ? "BlockDevice"
                  : stat.isCharacterDevice()
                    ? "CharacterDevice"
                    : stat.isFIFO()
                      ? "FIFO"
                      : stat.isSocket()
                        ? "Socket"
                        : "Unknown",
          mtime: Option.fromNullishOr(stat.mtime),
          atime: Option.fromNullishOr(stat.atime),
          birthtime: Option.fromNullishOr(stat.birthtime),
          dev: stat.dev,
          rdev: Option.fromNullishOr(stat.rdev),
          ino: Option.fromNullishOr(stat.ino),
          mode: number(stat.mode),
          nlink: Option.fromNullishOr(stat.nlink),
          uid: optionalNumber(stat.uid),
          gid: optionalNumber(stat.gid),
          size: ByteSize.bytes(stat.size),
          blksize:
            stat.blksize === undefined ? Option.none() : Option.some(ByteSize.bytes(stat.blksize)),
          blocks: Option.fromNullishOr(stat.blocks),
        }),
        catch: (cause) => PlatformError.badArgument({ module: "FileSystem", method, cause }),
      }),
    ),
  );

/** Cleanup operates on physical files; packaged app assets keep their normal filesystem. */
export const physicalCleanupFileSystem = (provided: FileSystem.FileSystem): CleanupFileSystem => {
  // Preserve injected filesystems in ordinary Node servers and tests.
  if (!isElectron) return provided;
  return FileSystem.make({
    ...provided,
    access: (path, options) =>
      native("access", path, () =>
        NodeFSP.access(path, (options?.readable ? 4 : 0) | (options?.writable ? 2 : 0)),
      ),
    makeDirectory: (path, options) =>
      native("makeDirectory", path, () => NodeFSP.mkdir(path, options)).pipe(Effect.asVoid),
    readDirectory: (path, options) =>
      native("readDirectory", path, () => NodeFSP.readdir(path, options)),
    readFile: (path) => native("readFile", path, () => NodeFSP.readFile(path)),
    readLink: (path) => native("readLink", path, () => NodeFSP.readlink(path)),
    realPath: (path) => native("realPath", path, () => NodeFSP.realpath(path)),
    remove: (path, options) => native("remove", path, () => NodeFSP.rm(path, options)),
    rename: (from, to) => native("rename", from, () => NodeFSP.rename(from, to)),
    stat: physicalStat("stat"),
    lstat: physicalStat("lstat"),
    writeFile: (path, data, options) =>
      native("writeFile", path, () => NodeFSP.writeFile(path, data, options)),
  });
};
