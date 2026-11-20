import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type TerminalSummary } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { FetchHttpClient } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as WorkspaceAcquisitionTestkit from "../workspace/WorkspaceAcquisition.testkit.ts";
import * as Hosting from "./Hosting.ts";
import * as PortScanner from "./PortScanner.ts";

it.effect.each([false, true])(
  "discovers a newly launched preview with routine scans paused (already retained: %s)",
  (alreadyRetained) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hosting-explicit-demand-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const retained = yield* Deferred.make<void>();
      const url = "http://localhost:43123/";
      let listening = false;
      let scans = 0;
      let writes = 0;
      let summary: TerminalSummary | undefined;
      const scannerLayer = PortScanner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "darwin"),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({
              shouldRunOpportunisticWork: Effect.succeed(false),
            }),
            Layer.succeed(ProcessRunner.ProcessRunner, {
              run: (input) =>
                Effect.sync(() => {
                  const isListenerScan = input.args.includes("-iTCP");
                  if (isListenerScan) {
                    scans += 1;
                  }
                  return {
                    stdout: isListenerScan && listening ? "p1234\ncnode\nn*:43123\n" : "",
                    stderr: "",
                    code: ChildProcessSpawner.ExitCode(0),
                    timedOut: false,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                    stdoutInvalidUtf8: false,
                    stderrInvalidUtf8: false,
                  };
                }),
            }),
            FetchHttpClient.layer.pipe(
              Layer.provide(
                Layer.succeed(FetchHttpClient.Fetch, (() =>
                  listening
                    ? Promise.resolve(
                        new Response("ready", { headers: { "content-type": "text/html" } }),
                      )
                    : Promise.reject(new TypeError("not listening yet"))) as typeof fetch),
              ),
            ),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const discovery = yield* PortScanner.PortDiscovery;
        const terminals = Layer.mock(TerminalManager.TerminalManager)({
          open: (input) => {
            summary = {
              threadId: input.threadId,
              terminalId: input.terminalId,
              cwd: input.cwd,
              worktreePath: input.worktreePath ?? null,
              status: "running",
              pid: 1234,
              exitCode: null,
              exitSignal: null,
              hasRunningSubprocess: false,
              label: "preview",
              updatedAt: "1970-01-01T00:00:00.000Z",
            };
            return Effect.succeed({ ...summary, history: "" });
          },
          write: () => {
            writes += 1;
            summary = { ...summary!, hasRunningSubprocess: true };
            return Effect.void;
          },
          metadata: Effect.sync(() => (summary ? [summary] : [])),
          refreshMetadata: Effect.gen(function* () {
            if (summary?.hasRunningSubprocess) {
              yield* discovery.registerTerminalProcesses({
                threadId: summary.threadId,
                terminalId: summary.terminalId,
                processIds: [1234],
              });
            }
            return summary ? [summary] : [];
          }),
          close: () =>
            Effect.sync(() => {
              summary = undefined;
            }),
          waitForThreadShutdown: () => Effect.void,
        });
        if (alreadyRetained) yield* discovery.retain;
        const hostingLayer = Hosting.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              WorkspaceAcquisitionTestkit.layer,
              Layer.succeed(PortScanner.PortDiscovery, {
                ...discovery,
                retain: discovery.retain.pipe(
                  Effect.tap(() => Deferred.succeed(retained, undefined)),
                ),
              }),
              ServerConfig.layer(config),
              terminals,
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThread: () => Effect.succeed({ archivedAt: null, deletedAt: null } as never),
              }),
              Layer.mock(NetService.NetService)({
                hasListenerOnHost: () => Effect.sync(() => listening),
              }),
              FetchHttpClient.layer,
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const hosting = yield* Hosting.PreviewHosting;
          const pending = yield* Effect.forkScoped(
            Effect.result(
              hosting.launch({
                threadId: "preview-thread",
                command: "node server.mjs",
                cwd: root,
                url,
              }),
            ),
          );
          yield* Deferred.await(retained);
          listening = true;
          const beforeReady = scans;
          yield* TestClock.adjust(Duration.seconds(31));
          const result = yield* Fiber.join(pending);
          assert.equal(
            result._tag,
            "Success",
            result._tag === "Failure" ? result.failure.message : undefined,
          );
          if (result._tag === "Success") assert.equal(result.success.status, "active");
          assert.equal(writes, 1);
          assert.isAbove(scans, beforeReady);
          const afterReady = scans;
          yield* TestClock.adjust(Duration.seconds(9));
          assert.equal(scans, afterReady);
        }).pipe(Effect.provide(hostingLayer));
      }).pipe(Effect.provide(scannerLayer));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
