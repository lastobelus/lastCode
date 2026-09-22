export interface NightlyTag {
  readonly tag: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly date: number;
  readonly runNumber: number;
}

export interface LastCodeInstallableTag {
  readonly tag: string;
  readonly nightly: NightlyTag;
  readonly revision: number;
}

export const LASTCODE_CHECKPOINT_TAG_PREFIX = "lastcode/checkpoint/";
export const LASTCODE_REVISION_TAG_PREFIX = "lastcode/revision/";

export function parseNightlyTag(tag: string): NightlyTag | undefined {
  const match = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/.exec(tag);
  if (!match) return undefined;

  const [, major, minor, patch, date, runNumber] = match;
  if (!major || !minor || !patch || !date || !runNumber) return undefined;

  return {
    tag,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    date: Number(date),
    runNumber: Number(runNumber),
  };
}

export function versionFromNightlyTag(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

export function nightlyTagFromCheckpointTag(tag: string): string | undefined {
  if (!tag.startsWith(LASTCODE_CHECKPOINT_TAG_PREFIX)) return undefined;
  const nightlyTag = tag.slice(LASTCODE_CHECKPOINT_TAG_PREFIX.length);
  return parseNightlyTag(nightlyTag) ? nightlyTag : undefined;
}

export function parseLastCodeInstallableTag(tag: string): LastCodeInstallableTag | undefined {
  const checkpointNightly = nightlyTagFromCheckpointTag(tag);
  if (checkpointNightly) {
    return { tag, nightly: parseNightlyTag(checkpointNightly)!, revision: 0 };
  }
  if (!tag.startsWith(LASTCODE_REVISION_TAG_PREFIX)) return undefined;
  const value = tag.slice(LASTCODE_REVISION_TAG_PREFIX.length);
  const match = /^(v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+)\.(\d+)$/.exec(value);
  if (!match) return undefined;
  const [, nightlyValue, revisionValue] = match;
  const nightly = nightlyValue ? parseNightlyTag(nightlyValue) : undefined;
  const revision = Number(revisionValue);
  if (!nightly || !Number.isSafeInteger(revision) || revision < 1) return undefined;
  return { tag, nightly, revision };
}

export function versionFromLastCodeInstallableTag(tag: string): string {
  const installable = parseLastCodeInstallableTag(tag);
  if (!installable) throw new Error(`Invalid LastCode installable tag '${tag}'.`);
  const nightlyVersion = versionFromNightlyTag(installable.nightly.tag);
  return installable.revision === 0 ? nightlyVersion : `${nightlyVersion}.${installable.revision}`;
}
