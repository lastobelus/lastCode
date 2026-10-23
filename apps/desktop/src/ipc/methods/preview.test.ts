import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewCaptureFailure,
  DesktopPreviewWebviewConfigSchema,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "../../preview/Manager.ts";
import * as PreviewIpc from "./preview.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as BrowserProfileScope from "../../preview/BrowserProfileScope.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../../wsl/DesktopWslEnvironment.ts";

const profileScope = (environmentId: string, profileId: string | undefined) =>
  BrowserProfileScope.resolvePartitionScope(environmentId, profileId, "desktop");
const decodePreviewConfig = Schema.decodeUnknownEffect(DesktopPreviewWebviewConfigSchema);

const layerProfileScope = Layer.mergeAll(
  Layer.mock(DesktopBackendPool.DesktopBackendPool)({
    primary: Effect.die("Persisted browser profiles must not read the primary backend"),
  }),
  DesktopAppSettings.layerTest(),
  DesktopWslEnvironment.layerTest(),
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "preview-ipc-profile-scope-" });
      const stateDir = `${baseDir}/userdata`;
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(`${stateDir}/browser-profile-environment-id`, "desktop\n");
      return DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/src",
        homeDirectory: baseDir,
        platform: "darwin",
        processArch: "x64",
        appVersion: "1.2.3",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/missing/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.merge(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
        ),
      );
    }),
  ),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Persisted browser profiles must not request HTTP")),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const { fromPartition } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

const decodeCaptureFailure = Schema.decodeUnknownEffect(PreviewCaptureFailure);

describe("preview IPC methods", () => {
  const invokeCapture = (
    method: typeof PreviewIpc.startRecording | typeof PreviewIpc.captureScreenshot,
    manager: Partial<PreviewManager.PreviewManager["Service"]>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
        const ipc = DesktopIpc.make({
          removeHandler: vi.fn(),
          handle: (_channel, registered) => {
            listener = registered;
          },
          removeAllListeners: vi.fn(),
          on: vi.fn(),
        });
        yield* ipc.handle(method);
        return yield* Effect.promise(async () =>
          structuredClone(await listener!({ sender: { id: 7 } }, { tabId: "capture-tab" })),
        );
      }).pipe(
        Effect.provideService(
          PreviewManager.PreviewManager,
          manager as PreviewManager.PreviewManager["Service"],
        ),
        Effect.provideService(DesktopClientSettings.DesktopClientSettings, {
          get: Effect.succeedNone,
          set: () => Effect.void,
        }),
      ),
    );

  effectIt.effect.each([
    {
      cause: new Error("Current display surface not available for capture"),
      reason: "capture-unavailable",
      guidance: ["target tab", "unlocked", "display is on", "window is restored"],
    },
    {
      cause: new Cause.TimeoutError(),
      reason: "capture-timeout",
      guidance: ["timed out during capture-page"],
    },
    {
      cause: new Error("Current display surface not available for capture: private page data"),
      reason: "capture-failed",
      guidance: ["Preview capture failed during capture-page"],
    },
  ])(
    "transports a safe $reason screenshot diagnostic through registered IPC",
    ({ cause, reason, guidance }) =>
      Effect.gen(function* () {
        const result = yield* invokeCapture(PreviewIpc.captureScreenshot, {
          captureScreenshot: (tabId) =>
            Effect.fail(
              new PreviewManager.PreviewOperationError({
                operation: "captureScreenshot.capturePage",
                tabId,
                artifactPath: "/private/capture.png",
                cause,
              }),
            ),
        });
        expect(result).toEqual({
          _tag: "PreviewCaptureFailure",
          reason,
          stage: "capture-page",
        });
        const failure = yield* decodeCaptureFailure(result);
        for (const phrase of guidance) expect(failure.message).toContain(phrase);
      }),
  );

  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    fromPartition.mockClear();
  });

  it("derives distinct partition scopes when identifiers contain the delimiter", () => {
    const first = profileScope("a", "b::c");
    const second = profileScope("a::b", "c");

    expect(first).toEqual({ scope: '["desktop","b::c"]', persistent: true, namespace: "profile" });
    expect(second).toEqual({ scope: '["desktop","c"]', persistent: true, namespace: "profile" });
    expect(first.scope).not.toBe(second.scope);
  });

  it("keeps the legacy default partition scope and incognito persistence", () => {
    expect(profileScope("environment::legacy", undefined)).toEqual({
      scope: "environment::legacy",
      persistent: true,
    });
    expect(profileScope("environment::legacy", DEFAULT_BROWSER_PROFILE_ID)).toEqual({
      scope: "environment::legacy",
      persistent: true,
    });
    expect(profileScope("environment::legacy", INCOGNITO_BROWSER_PROFILE_ID)).toEqual({
      scope: '["environment::legacy","incognito"]',
      persistent: false,
      namespace: "profile",
    });
  });
  effectIt.effect("clears the same named partition returned for local and remote tabs", () => {
    vi.stubGlobal("__dirname", "/app");
    const cleared: Array<ReadonlyArray<string> | undefined> = [];
    const sessions: string[] = [];
    const manager = Layer.mock(PreviewManager.PreviewManager)({
      isBrowserPartition: () => true,
      getBrowserSession: (scope) =>
        Effect.sync(() => {
          sessions.push(scope!);
          return null as never;
        }),
      getBrowserPartition: (scope) => Effect.succeed(`persist:${scope}`),
      clearCookies: (partitions) =>
        Effect.sync(() => {
          cleared.push(partitions);
        }),
      clearCache: (partitions) =>
        Effect.sync(() => {
          cleared.push(partitions);
        }),
    });
    return Effect.gen(function* () {
      const local = yield* PreviewIpc.getPreviewConfig
        .handler({
          environmentId: "desktop",
          profileId: "work",
        })
        .pipe(Effect.flatMap(decodePreviewConfig));
      const remote = yield* PreviewIpc.getPreviewConfig
        .handler({
          environmentId: "remote",
          profileId: "work",
        })
        .pipe(Effect.flatMap(decodePreviewConfig));
      yield* PreviewIpc.clearCookies.handler({ environmentId: "remote", profileId: "work" });
      yield* PreviewIpc.clearCache.handler({ environmentId: "desktop", profileId: "work" });
      expect(local.partition).toBe('persist:["desktop","work"]');
      expect(remote.partition).toBe(local.partition);
      expect(cleared).toEqual([[local.partition], [local.partition]]);
      expect(sessions).toEqual(Array(4).fill('["desktop","work"]'));
    }).pipe(Effect.provide(Layer.merge(manager, layerProfileScope)));
  });
});
