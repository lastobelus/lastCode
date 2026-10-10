// @effect-diagnostics nodeBuiltinImport:off -- Checkpoint policy reads a repository-owned manifest.
import * as NodeFS from "node:fs";

export type CheckpointReplayMode = "carry" | "historical";

export interface CarryBootstrap {
  readonly base: string;
  readonly source: string;
  readonly head: string;
  readonly ref?: string;
  readonly representedSource?: string;
  readonly sourceTag?: string;
}

export type ManifestReplayConfiguration = {
  readonly mode: "carry";
  readonly bootstrap: CarryBootstrap;
};

export interface EffectiveReplayConfiguration {
  readonly mode: CheckpointReplayMode;
  readonly configuredMode: CheckpointReplayMode | "legacy";
  readonly rollbackReason?: string;
  readonly bootstrap?: CarryBootstrap;
}

function requiredCommit(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(
      `Carry replay manifest requires replay.bootstrap.${field} to be an exact 40-character commit.`,
    );
  }
  return value;
}

export function parseManifestReplayConfiguration(
  manifest: unknown,
): ManifestReplayConfiguration | undefined {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Invalid carry-set manifest.");
  }
  const replay = (manifest as Record<string, unknown>).replay;
  if (replay === undefined) return undefined;
  if (replay === null || typeof replay !== "object" || Array.isArray(replay)) {
    throw new Error("Invalid carry replay configuration.");
  }
  const record = replay as Record<string, unknown>;
  if (record.mode !== "carry") {
    throw new Error("Carry replay manifest mode must be 'carry'.");
  }
  const bootstrap = record.bootstrap;
  if (bootstrap === null || typeof bootstrap !== "object" || Array.isArray(bootstrap)) {
    throw new Error("Carry replay mode requires replay.bootstrap.");
  }
  const fields = bootstrap as Record<string, unknown>;
  const ref = fields.ref;
  if (ref !== undefined && (typeof ref !== "string" || ref.trim() === "")) {
    throw new Error("Carry replay manifest replay.bootstrap.ref must be nonempty.");
  }
  const representedSource = fields.representedSource;
  const sourceTag = fields.sourceTag;
  if ((representedSource === undefined) !== (sourceTag === undefined)) {
    throw new Error(
      "Carry replay manifest replay.bootstrap.representedSource and sourceTag must be configured together.",
    );
  }
  if (
    sourceTag !== undefined &&
    (typeof sourceTag !== "string" ||
      !/^lastcode\/(?:checkpoint|revision)\/v\S+-nightly\.\S+$/u.test(sourceTag))
  ) {
    throw new Error(
      "Carry replay manifest replay.bootstrap.sourceTag must name an immutable LastCode installable tag.",
    );
  }
  return {
    mode: "carry",
    bootstrap: {
      base: requiredCommit(fields.base, "base"),
      source: requiredCommit(fields.source, "source"),
      head: requiredCommit(fields.head, "head"),
      ...(typeof ref === "string" ? { ref } : {}),
      ...(representedSource === undefined
        ? {}
        : { representedSource: requiredCommit(representedSource, "representedSource") }),
      ...(typeof sourceTag === "string" ? { sourceTag } : {}),
    },
  };
}

export function readManifestReplayConfiguration(
  manifestPath: string,
): ManifestReplayConfiguration | undefined {
  return parseManifestReplayConfiguration(JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")));
}

export function resolveCheckpointReplay(input: {
  readonly configured: ManifestReplayConfiguration | undefined;
  readonly requestedMode?: CheckpointReplayMode;
  readonly rollbackReason?: string;
}): EffectiveReplayConfiguration {
  const configuredMode = input.configured?.mode ?? "legacy";
  const mode = input.requestedMode ?? input.configured?.mode ?? "historical";
  const rollbackReason = input.rollbackReason?.trim();
  if (mode === "carry" && configuredMode !== "carry") {
    throw new Error("--replay-mode carry requires an activated carry replay manifest.");
  }
  if (configuredMode === "carry" && mode === "historical" && !rollbackReason) {
    throw new Error(
      "--replay-mode historical requires a nonempty --rollback-reason while carry replay is configured.",
    );
  }
  if (rollbackReason && !(configuredMode === "carry" && mode === "historical")) {
    throw new Error(
      "--rollback-reason is only valid for an explicit carry-to-historical rollback.",
    );
  }
  return {
    mode,
    configuredMode,
    ...(rollbackReason ? { rollbackReason } : {}),
    ...(input.configured?.mode === "carry" ? { bootstrap: input.configured.bootstrap } : {}),
  };
}

export function sourceObjectRef(installableTag: string): string {
  const version = installableTag.replace(/^lastcode\/(?:checkpoint|revision)\//, "").trim();
  if (!version || version === installableTag || version.includes("..")) {
    throw new Error(`Cannot derive immutable source ref for '${installableTag}'.`);
  }
  return `refs/lastcode/sources/${version}`;
}

export function immutableSourceFetchRefspec(): string {
  return "refs/lastcode/sources/*:refs/lastcode/sources/*";
}

export function installablePublicationArgs(input: {
  readonly remote: string;
  readonly installableTag: string;
  readonly sourceCommit: string;
  readonly noVerify: boolean;
  readonly expectedRemoteSource?: string;
}): ReadonlyArray<string> {
  return [
    "push",
    ...(input.noVerify ? ["--no-verify"] : []),
    "--atomic",
    `--force-with-lease=${sourceObjectRef(input.installableTag)}:${input.expectedRemoteSource ?? "0000000000000000000000000000000000000000"}`,
    input.remote,
    input.installableTag,
    `${input.sourceCommit}:${sourceObjectRef(input.installableTag)}`,
  ];
}
