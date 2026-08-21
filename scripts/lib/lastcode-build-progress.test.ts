// @effect-diagnostics nodeBuiltinImport:off -- This host-side test reads emitter source files directly to catch marker drift.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  BUILD_PHASES,
  estimateBuildProgress,
  resolveBuildPhaseIndex,
} from "./lastcode-build-progress.ts";

const expectedLabels = [
  "Preparing",
  "Preparing",
  "Installing deps",
  "Electron setup",
  "Electron setup",
  "Format & lint",
  "Typechecking",
  "Workspace tests",
  "Rust format",
  "Desktop build",
  "Preload checks",
  "Rust tests",
  "Mobile tools",
  "Mobile lint",
  "Release smoke",
  "Building artifacts",
  "Building artifacts",
  "Building artifacts",
  "Building artifacts",
  "Branding",
  "Staging app",
  "Installing deps",
  "Building DMG",
  "Finalizing",
  "Finalizing",
];

describe("LastCode local build progress model", () => {
  it("covers every concrete CI phase without drifting from the CI runner", () => {
    const ciSource = NodeFS.readFileSync(
      new URL("../lastcode-local-ci.ts", import.meta.url),
      "utf8",
    );
    const quickSteps = ciSource.slice(
      ciSource.indexOf("const QUICK_STEPS"),
      ciSource.indexOf("const FULL_ONLY_STEPS"),
    );
    const fullOnlySteps = ciSource.slice(
      ciSource.indexOf("const FULL_ONLY_STEPS"),
      ciSource.indexOf("const PRELOAD_PATH"),
    );
    const ciLabels = [
      ...quickSteps.matchAll(/label: "([^"]+)"/g),
      ...fullOnlySteps.matchAll(/label: "([^"]+)"/g),
    ].map((match) => match[1]);
    const ciMarkers = BUILD_PHASES.filter(({ marker }) => marker.startsWith("[lastcode:ci] "))
      .filter(({ marker }) => !marker.includes("Full local CI passed"))
      .map(({ marker }) => marker);

    expect(ciMarkers).toEqual(
      ciLabels.map((label, index) => `[lastcode:ci] ${index + 1}/${ciLabels.length} ${label}`),
    );
    expect(BUILD_PHASES.map(({ label }) => label)).toEqual(expectedLabels);
    expect(new Set(BUILD_PHASES.map(({ marker }) => marker)).size).toBe(BUILD_PHASES.length);
    expect(
      BUILD_PHASES.every(({ label }) => {
        const wordCount = label.split(/\s+/).length;
        return wordCount >= 1 && wordCount <= 3;
      }),
    ).toBe(true);
  });

  it("keeps owned non-CI markers coupled to their emitters", () => {
    const markersByEmitter = new Map([
      ["../lastcode-local-update.mjs", ["Reusing full local CI stamp"]],
      ["../lastcode-local-ci.ts", ["[lastcode:ci] Full local CI passed"]],
      ["../lastcode-build-mac.ts", ["[lastcode:build] Building", "[lastcode:build] Created"]],
      [
        "../build-desktop-artifact.ts",
        [
          "[desktop-artifact] Building desktop/server/web artifacts",
          "web client branding",
          "[desktop-artifact] Staging release app",
          "[desktop-artifact] Installing staged production dependencies",
          "[desktop-artifact] Done. Artifacts",
        ],
      ],
    ]);

    for (const [relativePath, markers] of markersByEmitter) {
      const source = NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");
      for (const marker of markers) {
        expect(source, `${marker} must remain emitted by ${relativePath}`).toContain(marker);
        expect(BUILD_PHASES.some((phase) => phase.marker === marker)).toBe(true);
      }
    }

    const localUpdateSource = NodeFS.readFileSync(
      new URL("../lastcode-local-update.mjs", import.meta.url),
      "utf8",
    );
    expect(localUpdateSource).toContain('const CHECKPOINT_PREFIX = "lastcode/checkpoint/"');
    expect(localUpdateSource).toContain("Building ${options.checkpointTag}");
    expect(BUILD_PHASES[0].marker).toBe("Building lastcode/");
  });

  it("advances only forward through every real marker", () => {
    let phaseIndex = 0;
    const observed: Array<number> = [];
    for (const [index, phase] of BUILD_PHASES.entries()) {
      phaseIndex = resolveBuildPhaseIndex(phase.marker, phaseIndex);
      observed.push(phaseIndex);
      expect(phaseIndex).toBe(index);
    }

    expect(observed).toEqual(BUILD_PHASES.map((_, index) => index));
    expect(resolveBuildPhaseIndex(BUILD_PHASES[0].marker, phaseIndex)).toBe(phaseIndex);
    expect(resolveBuildPhaseIndex("unrelated output", phaseIndex)).toBe(phaseIndex);
  });

  it("jumps over CI when a reusable full-CI stamp is present", () => {
    const installPhase = resolveBuildPhaseIndex("Scope: all");
    const reusedPhase = resolveBuildPhaseIndex("Reusing full local CI stamp", installPhase);

    expect(BUILD_PHASES[reusedPhase]).toMatchObject({
      label: "Building artifacts",
      start: 0.75,
    });
    expect(reusedPhase).toBeGreaterThan(
      BUILD_PHASES.findIndex(({ marker }) => marker.includes("11/11 Release smoke")),
    );
  });

  it("keeps estimates monotonic and below completion", () => {
    let previous = 0;
    for (const [index, phase] of BUILD_PHASES.entries()) {
      expect(phase.estimateMs).toBeGreaterThan(0);
      expect(phase.start).toBeGreaterThanOrEqual(previous);

      const estimates = [
        estimateBuildProgress(index, -1),
        estimateBuildProgress(index, 0),
        estimateBuildProgress(index, phase.estimateMs / 2),
        estimateBuildProgress(index, phase.estimateMs),
        estimateBuildProgress(index, Number.POSITIVE_INFINITY),
      ];
      expect(estimates).toEqual(estimates.toSorted((left, right) => left - right));
      expect(estimates.every((progress) => progress >= phase.start && progress < 1)).toBe(true);
      previous = phase.start;
    }
  });
});
