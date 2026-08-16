import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  BUILD_PHASES,
  estimateBuildProgress,
  parseBuildResult,
  parseOptions,
  renderProgressBar,
  renderLauncher,
  resolveBuildPhaseIndex,
  resolveCheckpointTag,
  sanitizeLogLine,
  uninstallCommand,
} from "./lastcode-build.mjs";

const tags = [
  "lastcode/checkpoint/v0.0.34-nightly.20260814.1090",
  "lastcode/checkpoint/v0.0.34-nightly.20260814.1092",
  "lastcode/checkpoint/v0.0.34-nightly.20260814.1095",
];

describe("LastCode userland build command", () => {
  it("accepts positional and named checkpoint selectors", () => {
    expect(parseOptions(["1090"]).checkpoint).toBe("1090");
    expect(parseOptions(["--checkpoint", "1092"]).checkpoint).toBe("1092");
    expect(parseOptions(["-c", "1095"]).checkpoint).toBe("1095");
    expect(() => parseOptions(["1090", "1092"])).toThrow("Unexpected second checkpoint");
    expect(parseOptions(["--uninstall"]).uninstall).toBe(true);
    expect(() => parseOptions(["--uninstall", "1090"])).toThrow("cannot be combined");
  });

  it("uninstalls only the managed build command artifacts", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-build-uninstall-"));
    try {
      const binDirectory = NodePath.join(home, ".lastcode", "bin");
      const exposedDirectory = NodePath.join(home, ".local", "bin");
      const target = NodePath.join(binDirectory, "lastcode-build");
      const exposed = NodePath.join(exposedDirectory, "lastcode-build");
      const dashboard = NodePath.join(home, ".lastcode", "dashboard.json");
      NodeFS.mkdirSync(binDirectory, { recursive: true });
      NodeFS.mkdirSync(exposedDirectory, { recursive: true });
      for (const name of ["lastcode-build", "lastcode-build.mjs", "lastcode-local-update.mjs"]) {
        NodeFS.writeFileSync(NodePath.join(binDirectory, name), "managed");
      }
      NodeFS.writeFileSync(dashboard, "shared config");
      NodeFS.symlinkSync(target, exposed);

      uninstallCommand(home);

      expect(NodeFS.existsSync(exposed)).toBe(false);
      expect(NodeFS.existsSync(target)).toBe(false);
      expect(NodeFS.existsSync(dashboard)).toBe(true);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("selects the newest checkpoint by default", () => {
    expect(resolveCheckpointTag(tags)).toBe("lastcode/checkpoint/v0.0.34-nightly.20260814.1095");
  });

  it("resolves checkpoint number shorthand and full tags", () => {
    expect(resolveCheckpointTag(tags, "1090")).toBe(
      "lastcode/checkpoint/v0.0.34-nightly.20260814.1090",
    );
    expect(resolveCheckpointTag(tags, "v0.0.34-nightly.20260814.1092")).toBe(
      "lastcode/checkpoint/v0.0.34-nightly.20260814.1092",
    );
    expect(resolveCheckpointTag(tags, "lastcode/checkpoint/v0.0.34-nightly.20260814.1095")).toBe(
      "lastcode/checkpoint/v0.0.34-nightly.20260814.1095",
    );
  });

  it("rejects missing and ambiguous shorthand", () => {
    expect(() => resolveCheckpointTag(tags, "1000")).toThrow("was not found");
    expect(() =>
      resolveCheckpointTag(
        [
          "lastcode/checkpoint/v0.0.34-nightly.20260814.1090",
          "lastcode/checkpoint/v0.0.35-nightly.20260815.1090",
        ],
        "1090",
      ),
    ).toThrow("ambiguous");
  });

  it("parses the existing local update helper result", () => {
    expect(
      parseBuildResult(
        'noise\nLASTCODE_LOCAL_UPDATE_RESULT={"schemaVersion":1,"status":"built","outputDir":"/tmp/build"}\n',
      ),
    ).toMatchObject({ status: "built", outputDir: "/tmp/build" });
  });

  it("advances estimated progress from build log stage markers", () => {
    const testsPhase = resolveBuildPhaseIndex("[lastcode:ci] 4/11 Workspace tests");
    expect(BUILD_PHASES[testsPhase].start).toBe(0.2);
    expect(estimateBuildProgress(testsPhase, 75_000)).toBeGreaterThan(0.2);
    expect(estimateBuildProgress(testsPhase, 1_000_000)).toBeLessThan(0.35);
    expect(resolveBuildPhaseIndex("older output", testsPhase)).toBe(testsPhase);
    expect(
      resolveBuildPhaseIndex("[desktop-artifact] Building mac/dmg", testsPhase),
    ).toBeGreaterThan(testsPhase);
  });

  it("renders a bounded estimated progress bar", () => {
    expect(renderProgressBar(0.25, 8)).toBe("<==------>  25% est.");
    expect(renderProgressBar(2, 4)).toBe("<====> 100% est.");
  });

  it("turns colored, long log output into one terminal-safe status line", () => {
    expect(sanitizeLogLine("\u001b[32mhello\u001b[0m\tworld", 80)).toBe("hello world");
    expect(sanitizeLogLine("a very long status line", 10)).toBe("a very lo…");
  });

  it("launches with the repository's pinned Node runtime", () => {
    expect(renderLauncher("/tmp/Last Code/lastcode-build.mjs")).toContain(
      "mise exec node@24.13.1 -- node '/tmp/Last Code/lastcode-build.mjs' \"$@\"",
    );
  });
});
