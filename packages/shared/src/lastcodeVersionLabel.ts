const NIGHTLY_VERSION = /^\d+\.\d+\.\d+-nightly\.([\d.]+)$/;
const BUILD_KEY = /^(\d{8})\.(\d+)(?:\.(\d+))?$/;

export function parseLastCodeVersion(version: string) {
  const key = NIGHTLY_VERSION.exec(version)?.[1];
  return key === undefined ? null : parseLastCodeBuildKey(key);
}

export function parseLastCodeBuildKey(key: string) {
  const match = BUILD_KEY.exec(key);
  if (match === null) return null;
  const [, buildDate, checkpointNumber, buildRevision] = match;
  const date = Number(buildDate);
  const checkpoint = Number(checkpointNumber);
  const revision = Number(buildRevision ?? 0);
  if (!Number.isSafeInteger(checkpoint) || !Number.isSafeInteger(revision)) return null;
  return { date, checkpoint, revision, key: `${buildDate}.${checkpoint}.${revision}` };
}

export function compareLastCodeBuilds(
  left: NonNullable<ReturnType<typeof parseLastCodeVersion>>,
  right: NonNullable<ReturnType<typeof parseLastCodeVersion>>,
) {
  return (
    left.date - right.date || left.checkpoint - right.checkpoint || left.revision - right.revision
  );
}

export function formatLastCodeVersion(version: string): string {
  const build = parseLastCodeVersion(version);
  if (build === null) return version;
  const date = String(build.date).padStart(8, "0");
  const checkpoint = build.revision ? `${build.checkpoint}.${build.revision}` : build.checkpoint;
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} • ${checkpoint}`;
}
