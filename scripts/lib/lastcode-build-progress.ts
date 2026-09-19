// LastCode managed module: local-build-progress

export interface LocalBuildPhase {
  readonly label: string;
  readonly marker: string;
  readonly start: number;
  readonly estimateMs: number;
}

export const BUILD_PHASES = [
  { label: "Preparing", marker: "Building lastcode/", start: 0, estimateMs: 10_000 },
  { label: "Preparing", marker: "Preparing worktree", start: 0.01, estimateMs: 20_000 },
  { label: "Installing deps", marker: "Scope: all", start: 0.03, estimateMs: 45_000 },
  { label: "Electron setup", marker: "Done in", start: 0.08, estimateMs: 5_000 },
  {
    label: "Electron setup",
    marker: "[lastcode:ci] 1/11 Ensure Electron runtime",
    start: 0.09,
    estimateMs: 5_000,
  },
  {
    label: "Format & lint",
    marker: "[lastcode:ci] 2/11 Format and lint",
    start: 0.1,
    estimateMs: 30_000,
  },
  {
    label: "Typechecking",
    marker: "[lastcode:ci] 3/11 Workspace typecheck",
    start: 0.14,
    estimateMs: 50_000,
  },
  {
    label: "Workspace tests",
    marker: "[lastcode:ci] 4/11 Workspace tests",
    start: 0.2,
    estimateMs: 300_000,
  },
  {
    label: "Rust format",
    marker: "[lastcode:ci] 5/11 Resource monitor formatting",
    start: 0.35,
    estimateMs: 10_000,
  },
  {
    label: "Desktop build",
    marker: "[lastcode:ci] 6/11 Desktop build",
    start: 0.36,
    estimateMs: 120_000,
  },
  {
    label: "Preload checks",
    marker: "[lastcode:ci] 7/11 Desktop preload bundle assertions",
    start: 0.49,
    estimateMs: 5_000,
  },
  {
    label: "Rust tests",
    marker: "[lastcode:ci] 8/11 Resource monitor tests",
    start: 0.5,
    estimateMs: 60_000,
  },
  {
    label: "Mobile tools",
    marker: "[lastcode:ci] 9/11 Mobile native tool prerequisites",
    start: 0.55,
    estimateMs: 5_000,
  },
  {
    label: "Mobile lint",
    marker: "[lastcode:ci] 10/11 Mobile native static analysis",
    start: 0.56,
    estimateMs: 90_000,
  },
  {
    label: "Release smoke",
    marker: "[lastcode:ci] 11/11 Release smoke",
    start: 0.64,
    estimateMs: 120_000,
  },
  {
    label: "Building artifacts",
    marker: "[lastcode:ci] Full local CI passed",
    start: 0.75,
    estimateMs: 5_000,
  },
  {
    label: "Building artifacts",
    marker: "Reusing full local CI stamp",
    start: 0.75,
    estimateMs: 5_000,
  },
  {
    label: "Building artifacts",
    marker: "[lastcode:build] Building",
    start: 0.76,
    estimateMs: 10_000,
  },
  {
    label: "Building artifacts",
    marker: "[desktop-artifact] Building desktop/server/web artifacts",
    start: 0.78,
    estimateMs: 35_000,
  },
  { label: "Branding", marker: "web client branding", start: 0.84, estimateMs: 10_000 },
  {
    label: "Staging app",
    marker: "[desktop-artifact] Staging release app",
    start: 0.86,
    estimateMs: 15_000,
  },
  {
    label: "Installing deps",
    marker: "[desktop-artifact] Installing staged production dependencies",
    start: 0.88,
    estimateMs: 12_000,
  },
  {
    label: "Building DMG",
    marker: "[desktop-artifact] Building mac/dmg",
    start: 0.94,
    estimateMs: 110_000,
  },
  {
    label: "Finalizing",
    marker: "[desktop-artifact] Done. Artifacts",
    start: 0.99,
    estimateMs: 10_000,
  },
  {
    label: "Finalizing",
    marker: "[lastcode:build] Created",
    start: 0.995,
    estimateMs: 5_000,
  },
] as const satisfies ReadonlyArray<LocalBuildPhase>;

export function resolveBuildPhaseIndex(logChunk: string, currentIndex = 0): number {
  let resolved = currentIndex;
  for (let index = currentIndex; index < BUILD_PHASES.length; index += 1) {
    const phase = BUILD_PHASES[index];
    if (phase && logChunk.includes(phase.marker)) resolved = index;
  }
  return resolved;
}

export function estimateBuildProgress(phaseIndex: number, elapsedMs: number): number {
  const phase = BUILD_PHASES[phaseIndex] ?? BUILD_PHASES[0];
  const nextStart = BUILD_PHASES[phaseIndex + 1]?.start ?? 1;
  const phaseFraction = Math.min(0.95, Math.max(0, elapsedMs) / phase.estimateMs);
  return phase.start + (nextStart - phase.start) * phaseFraction;
}
