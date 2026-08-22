import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class CodexThreadToolError extends Schema.TaggedErrorClass<CodexThreadToolError>()(
  "CodexThreadToolError",
  { cause: Schema.Defect() },
) {}

export interface CodexThreadToolInvocation {
  readonly executablePath: string;
  readonly cliEntryPath: string;
  readonly baseDir: string;
  readonly stateDir: string;
  readonly packagedMacos: boolean;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function renderCodexThreadToolWrapper(input: CodexThreadToolInvocation): string {
  const executable = [
    shellQuote(input.executablePath),
    shellQuote(input.cliEntryPath),
    "thread",
  ].join(" ");
  const pinnedFlags = `--base-dir ${shellQuote(input.baseDir)} --state-dir ${shellQuote(input.stateDir)}`;
  return `#!/bin/sh\n${input.packagedMacos ? "export ELECTRON_RUN_AS_NODE=1\n" : ""}case "$1" in\n  current|list|read) command="$1"; shift; exec ${executable} "$command" ${pinnedFlags} "$@" ;;\n  ""|-h|--help|help) exec ${executable} --help ;;\n  *) echo "lastcode-thread: unsupported command '$1'" >&2; exit 64 ;;\nesac\n`;
}

export const materializeCodexThreadTool = Effect.fn("materializeCodexThreadTool")(
  function* (input: {
    readonly stateDir: string;
    readonly baseDir: string;
    readonly executablePath?: string;
    readonly cliEntryPath?: string;
    readonly platform: NodeJS.Platform;
    readonly electronRunAsNode?: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const executablePath = input.executablePath ?? process.execPath;
    const cliEntryPath = input.cliEntryPath ?? process.argv[1];
    if (cliEntryPath === undefined || cliEntryPath.trim().length === 0) {
      return yield* new CodexThreadToolError({
        cause: new Error("The server CLI entry path is unavailable."),
      });
    }

    const binDir = path.join(input.stateDir, "bin");
    const wrapperPath = path.join(binDir, "lastcode-thread");
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(binDir, { recursive: true });
      yield* fileSystem.writeFileString(
        wrapperPath,
        renderCodexThreadToolWrapper({
          executablePath,
          cliEntryPath,
          baseDir: input.baseDir,
          stateDir: input.stateDir,
          packagedMacos:
            input.platform === "darwin" &&
            (input.electronRunAsNode ?? process.env.ELECTRON_RUN_AS_NODE) === "1",
        }),
      );
      yield* fileSystem.chmod(wrapperPath, 0o755);
    }).pipe(Effect.mapError((cause) => new CodexThreadToolError({ cause })));
    return { binDir, wrapperPath } as const;
  },
);
