import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewAutomationStatus,
  DesktopPreviewWebviewConfigSchema,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "../../preview/Manager.ts";
import * as BrowserImport from "../../preview/BrowserImport/BrowserImport.ts";
import * as PreviewIpc from "./preview.ts";
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

describe("preview IPC methods", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    fromPartition.mockClear();
  });

  it("does not access the Electron session while the module loads", async () => {
    await expect(import("./preview.ts")).resolves.toBeDefined();
    expect(fromPartition).not.toHaveBeenCalled();
  });

  it("derives distinct partition scopes when identifiers contain the delimiter", () => {
    const first = profileScope("a", "b::c");
    const second = profileScope("a::b", "c");

    expect(first).toEqual({ scope: '["desktop","b::c"]', persistent: true, namespace: "profile" });
    expect(second).toEqual({ scope: '["desktop","c"]', persistent: true, namespace: "profile" });
    expect(first.scope).not.toBe(second.scope);
  });

  it("preserves lone surrogates without collapsing them to replacement characters", () => {
    const highSurrogate = profileScope("environment", "profile-\ud800");
    const lowSurrogate = profileScope("environment", "profile-\udc00");
    const replacement = profileScope("environment", "profile-�");

    expect(highSurrogate.scope).toBe('["desktop","profile-\\ud800"]');
    expect(lowSurrogate.scope).toBe('["desktop","profile-\\udc00"]');
    expect(highSurrogate.scope).not.toBe(lowSurrogate.scope);
    expect(highSurrogate.scope).not.toBe(replacement.scope);
    expect(lowSurrogate.scope).not.toBe(replacement.scope);
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

  effectIt.effect("targets imports at the same partition tuple as the renderer", () => {
    const received: Array<Parameters<BrowserImport.BrowserImport["Service"]["importCookies"]>[0]> =
      [];
    const browserImport = BrowserImport.BrowserImport.of({
      listSources: Effect.succeed([]),
      importCookies: (input) =>
        Effect.sync(() => {
          received.push(input);
          return { imported: 0, skipped: 0, skippedDomains: [] };
        }),
    });
    const request = (environmentId: string, targetProfileId: string) =>
      PreviewIpc.importBrowserCookies.handler({
        environmentId,
        sourceId: "helium",
        sourceProfileDirectory: "Default",
        targetProfileId,
      });

    return Effect.gen(function* () {
      yield* request("a", "b");
      yield* request("a::b", DEFAULT_BROWSER_PROFILE_ID);

      expect(received[0]).toMatchObject(profileScope("a", "b"));
      expect(received[1]).toMatchObject(profileScope("a::b", DEFAULT_BROWSER_PROFILE_ID));
      expect(received[0]?.namespace).toBe("profile");
      expect(received[1]?.namespace).toBeUndefined();
    }).pipe(
      Effect.provideService(BrowserImport.BrowserImport, browserImport),
      Effect.provide(layerProfileScope),
    );
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

  effectIt.effect("rejects invalid webContents ids before resolving the preview service", () =>
    Effect.map(
      PreviewIpc.registerWebview
        .handler({ tabId: "tab-1", webContentsId: 0 })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, null as never), Effect.exit),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
        expect(fromPartition).not.toHaveBeenCalled();
      },
    ),
  );

  it("keeps the public automation status tab id limit", () => {
    const encode = Schema.encodeUnknownSync(PreviewAutomationStatus);
    const tabId = "t".repeat(129);

    expect(() =>
      encode({
        available: false,
        visible: true,
        tabId,
        url: null,
        title: null,
        loading: false,
      }),
    ).toThrow();
  });
});
