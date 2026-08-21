// @effect-diagnostics nodeBuiltinImport:off -- Progress transport tests use isolated host-side log fixtures.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  groupedInspectionArgs,
  LocalBuildProgressTracker,
  monitorLocalBuildProgress,
  parseHelperResult,
  terminateHelperProcess,
  usesDetachedHelperProcessGroup,
} from "./LastCodeLocalUpdates.ts";

describe("LastCodeLocalUpdates", () => {
  const withBuildLog = (run: (logPath: string) => void) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-progress-"));
    const logPath = NodePath.join(directory, "build.log");
    try {
      run(logPath);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  };

  it("requests the negotiated grouped release notes format", () => {
    assert.deepEqual(groupedInspectionArgs("1.2.3-nightly.4"), [
      "--current-version",
      "1.2.3-nightly.4",
      "--release-notes-format",
      "grouped-v1",
    ]);
  });

  it("parses the helper's final structured result", () => {
    assert.deepEqual(
      parseHelperResult(
        'noise\nLASTCODE_LOCAL_UPDATE_RESULT={"schemaVersion":1,"status":"built"}\n',
      ),
      { schemaVersion: 1, status: "built" },
    );
    assert.throws(() => parseHelperResult("noise only"), /did not return a result/);
  });

  it("terminates the detached helper process group on macOS", () => {
    const groupSignals: Array<[number, NodeJS.Signals]> = [];
    let directKills = 0;

    assert.isTrue(usesDetachedHelperProcessGroup("darwin"));
    assert.isFalse(usesDetachedHelperProcessGroup("win32"));
    assert.isTrue(
      terminateHelperProcess(
        {
          pid: 4242,
          kill: () => {
            directKills += 1;
            return true;
          },
        },
        "darwin",
        (pid, signal) => {
          groupSignals.push([pid, signal]);
          return true;
        },
      ),
    );
    assert.deepEqual(groupSignals, [[-4242, "SIGKILL"]]);
    assert.equal(directKills, 0);
  });

  it("tails only bytes appended after tracking starts", () => {
    withBuildLog((logPath) => {
      NodeFS.writeFileSync(logPath, "[desktop-artifact] Building mac/dmg\n", "utf8");
      const tracker = new LocalBuildProgressTracker(logPath, 0);

      assert.isNull(tracker.poll(0));
      NodeFS.appendFileSync(logPath, "[lastcode:ci] 4/11 Workspace tests\n", "utf8");

      assert.deepEqual(tracker.poll(100), {
        phase: "Workspace tests",
        percent: 20,
        errorKind: "build",
      });
    });
  });

  it("recognizes split markers and resets safely after truncation", () => {
    withBuildLog((logPath) => {
      NodeFS.writeFileSync(logPath, "", "utf8");
      const tracker = new LocalBuildProgressTracker(logPath, 0);

      NodeFS.appendFileSync(logPath, "[desktop-artifact] Building desktop/", "utf8");
      assert.isNull(tracker.poll(100));
      NodeFS.appendFileSync(logPath, "server/web artifacts\n", "utf8");
      assert.deepEqual(tracker.poll(200), {
        phase: "Building artifacts",
        percent: 78,
        errorKind: "packaging",
      });

      NodeFS.truncateSync(logPath, 0);
      assert.isNull(tracker.poll(300));
      NodeFS.appendFileSync(logPath, "[desktop-artifact] Building mac/dmg\n", "utf8");
      assert.deepEqual(tracker.poll(400), {
        phase: "Building DMG",
        percent: 94,
        errorKind: "packaging",
      });
    });
  });

  it("does not skip markers before an oversized appended burst", () => {
    withBuildLog((logPath) => {
      const tracker = new LocalBuildProgressTracker(logPath, 0);

      NodeFS.appendFileSync(
        logPath,
        `[desktop-artifact] Building desktop/server/web artifacts\n${"x".repeat(512_100)}`,
        "utf8",
      );

      assert.deepEqual(tracker.poll(100), {
        phase: "Building artifacts",
        percent: 78,
        errorKind: "packaging",
      });
    });
  });

  it("bounds each poll while continuing through an oversized appended burst", () => {
    withBuildLog((logPath) => {
      const tracker = new LocalBuildProgressTracker(logPath, 0);

      NodeFS.appendFileSync(
        logPath,
        `${"x".repeat(512_000)}[desktop-artifact] Building mac/dmg\n`,
        "utf8",
      );

      assert.isNull(tracker.poll(100));
      assert.deepEqual(tracker.poll(200), {
        phase: "Building DMG",
        percent: 94,
        errorKind: "packaging",
      });
    });
  });

  it("coalesces interpolation while keeping progress bounded below completion", () => {
    withBuildLog((logPath) => {
      const tracker = new LocalBuildProgressTracker(logPath, 0);

      NodeFS.writeFileSync(logPath, "[lastcode:ci] 3/11 Workspace typecheck\n", "utf8");
      assert.deepEqual(tracker.poll(100), {
        phase: "Typechecking",
        percent: 14,
        errorKind: "build",
      });
      assert.isNull(tracker.poll(500));
      const later = tracker.poll(10_100);
      assert.isNotNull(later);
      assert.isAbove(later?.percent ?? 0, 14);
      assert.isBelow(later?.percent ?? 100, 100);
      assert.isNull(tracker.poll(10_100));
    });
  });

  it.effect("stops tailing when the helper finishes", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-monitor-"));
        return { directory, logPath: NodePath.join(directory, "build.log") };
      }),
      ({ logPath }) =>
        Effect.gen(function* () {
          NodeFS.writeFileSync(logPath, "", "utf8");
          const helperDone = yield* Deferred.make<void>();
          const observed = yield* Ref.make<ReadonlyArray<string>>([]);
          const helperFiber = yield* monitorLocalBuildProgress(
            logPath,
            Deferred.await(helperDone),
            (progress) => Ref.update(observed, (phases) => [...phases, progress.phase]),
          ).pipe(Effect.forkChild({ startImmediately: true }));

          NodeFS.appendFileSync(logPath, "[lastcode:ci] 4/11 Workspace tests\n", "utf8");
          yield* TestClock.adjust(Duration.millis(400));
          assert.deepEqual(yield* Ref.get(observed), ["Workspace tests"]);

          yield* Deferred.succeed(helperDone, undefined);
          yield* Fiber.join(helperFiber);
          NodeFS.appendFileSync(logPath, "[desktop-artifact] Building mac/dmg\n", "utf8");
          yield* TestClock.adjust(Duration.seconds(1));
          assert.deepEqual(yield* Ref.get(observed), ["Workspace tests"]);
        }),
      ({ directory }) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true })),
    ),
  );
});
