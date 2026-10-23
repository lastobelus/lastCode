import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeBuffer from "node:buffer";
import { it } from "@effect/vitest";
import {
  type PreviewEvent,
  PreviewNativeCloseError,
  PreviewNativeCreateError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PubSub from "effect/PubSub";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { expect } from "vite-plus/test";
import { setPreviewBootstrapTokenOnUrl } from "@t3tools/shared/remote";

import * as ServerConfig from "../config.ts";
import * as PreviewManager from "./Manager.ts";

const DRAIN_LIMIT = 100;

interface EventCollector {
  readonly drain: Effect.Effect<ReadonlyArray<PreviewEvent>>;
}

/** The shared live layer retains state between tests; counts need unique thread ids. */
let nextThreadId = 0;
const freshThreadId = () => ThreadId.make(`thread-${++nextThreadId}`);

/** Subscribe synchronously before publishing so the forked consumer cannot miss events. */
const collectEvents = Effect.gen(function* () {
  const manager = yield* PreviewManager.PreviewManager;
  const subscription = yield* manager.subscribeEvents;
  const collector: EventCollector = {
    drain: PubSub.takeUpTo(subscription, DRAIN_LIMIT),
  };
  return collector;
}).pipe(Effect.withSpan("preview.test.collectEvents"));

const PreviewManagerTestLayer = PreviewManager.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-manager-" })),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer),
);

const isolatedPersistenceConfig = Effect.fn("preview.test.isolatedPersistenceConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "preview-session-persistence-" });
  return { ...config, stateDir: path.join(root, "state") };
});

it.layer(PreviewManagerTestLayer)("PreviewManager", (it) => {
  it.effect("releases native rendering while preserving its destination and desktop identity", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const threadId = freshThreadId();
      let closes = 0;
      const opened = yield* manager.open({
        threadId,
        url: "https://report.example/review?mode=logos#chart",
        runtime: "server",
        desktopHostId: "desktop-owner",
        profileId: "profile-work",
        automationOwner: "agent-owner",
        desktopPopup: {
          popupId: "native-popup",
          close: () =>
            Effect.sync(() => {
              closes += 1;
            }),
        },
      });
      yield* manager.nativeDormantConfirmed({ threadId, tabId: opened.tabId });
      const { sessions } = yield* manager.list({ threadId });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        tabId: opened.tabId,
        desktopHostId: "desktop-owner",
        profileId: "profile-work",
        automationOwner: "agent-owner",
        backingPage: "desktop",
        navStatus: { _tag: "Loading", url: "https://report.example/review?mode=logos#chart" },
      });
      expect(sessions[0]).not.toHaveProperty("desktopPopupId");
      yield* manager.close({ threadId, tabId: opened.tabId });
      expect(closes).toBe(0);
      expect((yield* manager.list({ threadId })).sessions).toEqual([]);
    }),
  );

  it.effect("restores canonical tab identities and settings without replaying opened events", () =>
    Effect.gen(function* () {
      const config = yield* isolatedPersistenceConfig();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const create = PreviewManager.make.pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
      );
      const first = yield* Effect.scoped(create);
      const threadId = freshThreadId();
      const destination = "http://127.0.0.1:5173/app/a%2Fb?token=application-code#section";
      const navigation = setPreviewBootstrapTokenOnUrl(
        new URL(destination),
        "one-use-credential",
      ).href;
      const opened = yield* first.open({
        threadId,
        browserHost: "environment",
        profileId: "incognito",
        automationOwner: "agent-owner",
        url: navigation,
        reveal: true,
      });
      yield* first.reportStatus({
        threadId,
        tabId: opened.tabId,
        serverControlled: true,
        navStatus: { _tag: "Success", url: navigation, title: "Retained app" },
        canGoBack: true,
        canGoForward: true,
      });
      yield* first.resize({
        threadId,
        tabId: opened.tabId,
        viewport: { _tag: "freeform", width: 900, height: 700 },
      });
      yield* first.adjust({ threadId, tabId: opened.tabId, colorScheme: "dark", zoomFactor: 1.25 });
      yield* first.requestReveal({ threadId, tabId: opened.tabId, force: true });
      const discarded = yield* first.open({ threadId, url: "https://example.com/discarded" });
      yield* first.close({ threadId, tabId: discarded.tabId });
      const before = yield* first.list({ threadId });
      const restarted = yield* Effect.scoped(create);
      const subscription = yield* restarted.subscribeEvents;
      const after = yield* restarted.list({ threadId });
      expect(after.serverEpoch).not.toBe(before.serverEpoch);
      expect(after.sessions).toEqual([
        expect.objectContaining({
          threadId,
          tabId: opened.tabId,
          profileId: "incognito",
          automationOwner: "agent-owner",
          reveal: true,
          runtime: "server",
          backingPage: "server",
          navStatus: { _tag: "Loading", url: destination, title: "Retained app" },
          canGoBack: false,
          canGoForward: false,
          viewport: { _tag: "freeform", width: 900, height: 700 },
          colorScheme: "dark",
          zoomFactor: 1.25,
        }),
      ]);
      expect(after.sessions[0]).not.toHaveProperty("revealRequest");
      expect(yield* PubSub.takeUpTo(subscription, DRAIN_LIMIT)).toEqual([]);
      const stored = yield* fs.readFileString(path.join(config.stateDir, "preview-sessions.json"));
      expect(stored).not.toContain("one-use-credential");
      expect(stored).toContain("token=application-code");
      expect(
        (yield* fs.stat(path.join(config.stateDir, "preview-sessions.json"))).mode & 0o777,
      ).toBe(0o600);
    }),
  );

  it.effect(
    "restores native root and popup destinations pinned to their desktop without stale window identities",
    () =>
      Effect.gen(function* () {
        const config = yield* isolatedPersistenceConfig();
        const create = PreviewManager.make.pipe(
          Effect.provideService(ServerConfig.ServerConfig, config),
        );
        const first = yield* Effect.scoped(create);
        const threadId = freshThreadId();
        const root = yield* first.open({
          threadId,
          runtime: "server",
          desktopHostId: "selected-desktop",
          profileId: "work-account",
          automationOwner: "agent-owner",
          url: "https://example.com/account",
          createDesktopRoot: () =>
            Effect.succeed({
              rootId: "old-native-root",
              publish: () => Effect.void,
              close: () => Effect.void,
            }),
        });
        const popup = yield* first.open({
          threadId,
          runtime: "server",
          desktopHostId: "selected-desktop",
          profileId: "work-account",
          url: "https://example.com/popup",
          desktopPopup: { popupId: "old-native-popup" },
        });
        const restarted = yield* Effect.scoped(create);
        const restored = yield* restarted.list({ threadId });
        expect(restored.sessions.map((tab) => tab.tabId)).toEqual([root.tabId, popup.tabId]);
        for (const tab of restored.sessions) {
          expect(tab).toMatchObject({
            runtime: "server",
            backingPage: "desktop",
            desktopHostId: "selected-desktop",
            profileId: "work-account",
          });
          expect(tab).not.toHaveProperty("desktopRootId");
          expect(tab).not.toHaveProperty("desktopPopupId");
        }
        expect(restored.sessions[0]?.automationOwner).toBe("agent-owner");
        yield* restarted.close({ threadId });
        const closedRestart = yield* Effect.scoped(create);
        expect((yield* closedRestart.list({ threadId })).sessions).toEqual([]);
      }),
  );

  it.effect.each([
    "unreadable",
    "invalid",
    "incompatible-version",
    "incompatible-session",
    "duplicate",
    "oversized",
    "unparseable-url",
  ] as const)("backs up %s retained state and opens durable new previews", (kind) =>
    Effect.gen(function* () {
      const config = yield* isolatedPersistenceConfig();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const create = PreviewManager.make.pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
      );
      const first = yield* Effect.scoped(create);
      const threadId = freshThreadId();
      const original = yield* first.open({
        threadId,
        url: "https://example.com/retained",
      });
      const file = path.join(config.stateDir, "preview-sessions.json");
      let broken: string;
      switch (kind) {
        case "unreadable":
          broken = JSON.stringify({ version: 1, sessions: [original] });
          break;
        case "invalid":
          broken = "not valid json";
          break;
        case "incompatible-version":
          broken = JSON.stringify({ version: 2, sessions: [original] });
          break;
        case "incompatible-session":
          broken = JSON.stringify({ version: 1, sessions: [original, { threadId }] });
          break;
        case "duplicate":
          broken = JSON.stringify({ version: 1, sessions: [original, original] });
          break;
        case "oversized":
          broken = "x".repeat(4 * 1024 * 1024 + 1);
          break;
        case "unparseable-url":
          broken = JSON.stringify({
            version: 1,
            sessions: [
              original,
              {
                ...original,
                tabId: "unparseable-tab",
                navStatus: { _tag: "Loading", url: "http://[invalid", title: "" },
              },
            ],
          });
          break;
      }
      yield* fs.writeFileString(file, broken);
      const originalBytes = yield* fs.readFile(file);
      let sessionWrites = 0;
      const guarded = FileSystem.make({
        ...fs,
        readFile: (filePath) =>
          kind === "unreadable" && filePath === file
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readFile",
                }),
              )
            : fs.readFile(filePath),
        rename: (from, to) => {
          if (to === file) sessionWrites += 1;
          return fs.rename(from, to);
        },
      });
      const warnings: unknown[] = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(message);
      });
      const restarted = yield* Effect.scoped(create).pipe(
        Effect.provideService(FileSystem.FileSystem, guarded),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      );
      const subscription = yield* restarted.subscribeEvents;
      expect(yield* restarted.list({})).toMatchObject({ sessions: [], revision: 0 });
      const backups = (yield* fs.readDirectory(config.stateDir)).filter((name) =>
        name.startsWith("preview-sessions.json.unreadable-"),
      );
      expect(backups).toHaveLength(1);
      const backupPath = path.join(config.stateDir, backups[0]!);
      expect(NodeBuffer.Buffer.compare(yield* fs.readFile(backupPath), originalBytes)).toBe(0);
      expect(yield* fs.exists(file)).toBe(false);
      expect(sessionWrites).toBe(0);
      expect(yield* PubSub.takeUpTo(subscription, DRAIN_LIMIT)).toEqual([]);
      expect(warnings).toEqual([
        expect.arrayContaining([
          expect.objectContaining({
            sessionsPath: file,
            backupPath,
            error: expect.stringContaining("left intact"),
          }),
        ]),
      ]);
      const opened = yield* restarted.open({ threadId, url: "https://example.com/new" });
      expect((yield* restarted.list({ threadId })).sessions).toEqual([opened]);
      expect(yield* PubSub.takeUpTo(subscription, DRAIN_LIMIT)).toEqual([
        expect.objectContaining({ type: "opened", snapshot: opened }),
      ]);
      expect(sessionWrites).toBe(1);
      const reloaded = yield* Effect.scoped(create);
      expect((yield* reloaded.list({ threadId })).sessions).toEqual([opened]);
      expect(NodeBuffer.Buffer.compare(yield* fs.readFile(backupPath), originalBytes)).toBe(0);
      expect(
        (yield* fs.readDirectory(config.stateDir)).filter((name) =>
          name.startsWith("preview-sessions.json.unreadable-"),
        ),
      ).toEqual(backups);
    }),
  );

  it.effect(
    "preserves the original and blocks writes when backing up unreadable sessions fails",
    () =>
      Effect.gen(function* () {
        const config = yield* isolatedPersistenceConfig();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(config.stateDir, "preview-sessions.json");
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* fs.writeFileString(file, "not valid json");
        const originalBytes = yield* fs.readFile(file);
        const renameFailure = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "rename",
        });
        let renameAttempts = 0;
        const guarded = FileSystem.make({
          ...fs,
          rename: () => {
            renameAttempts += 1;
            return Effect.fail(renameFailure);
          },
        });
        const warnings: unknown[] = [];
        const logger = Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(message);
        });
        const restarted = yield* PreviewManager.make.pipe(
          Effect.provideService(ServerConfig.ServerConfig, config),
          Effect.provideService(FileSystem.FileSystem, guarded),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        );
        const subscription = yield* restarted.subscribeEvents;
        const threadId = freshThreadId();
        expect(yield* restarted.list({})).toMatchObject({ sessions: [], revision: 0 });
        expect(warnings).toEqual([
          expect.arrayContaining([
            expect.objectContaining({
              sessionsPath: file,
              error: expect.stringContaining("left intact"),
            }),
          ]),
        ]);
        const failure = yield* restarted
          .open({ threadId, url: "https://example.com/new" })
          .pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: "PreviewSessionStorageError",
          cause: renameFailure,
        });
        let nativeCreates = 0;
        expect(
          yield* restarted
            .open({
              threadId,
              runtime: "server",
              desktopHostId: "selected-desktop",
              automationOwner: "agent-owner",
              createDesktopRoot: () => {
                nativeCreates += 1;
                return Effect.succeed({
                  rootId: "unexpected-native-root",
                  publish: () => Effect.void,
                  close: () => Effect.void,
                });
              },
            })
            .pipe(Effect.flip),
        ).toBe(failure);
        yield* restarted.close({ threadId });
        expect(yield* restarted.list({ threadId })).toMatchObject({ sessions: [], revision: 0 });
        expect(yield* PubSub.takeUpTo(subscription, DRAIN_LIMIT)).toEqual([]);
        expect(nativeCreates).toBe(0);
        expect(renameAttempts).toBe(1);
        expect(NodeBuffer.Buffer.compare(yield* fs.readFile(file), originalBytes)).toBe(0);
        expect(yield* fs.readDirectory(config.stateDir)).toEqual(["preview-sessions.json"]);
      }),
  );

  it.effect("keeps distinct byte-preserving backups across repeated startup recoveries", () =>
    Effect.gen(function* () {
      const config = yield* isolatedPersistenceConfig();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(config.stateDir, "preview-sessions.json");
      const create = PreviewManager.make.pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
      );
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      const firstBytes = new Uint8Array([0xff, 0x00, 0x7b]);
      yield* fs.writeFile(file, firstBytes);
      yield* Effect.scoped(create);
      const [firstBackup] = yield* fs.readDirectory(config.stateDir);
      expect(firstBackup).toMatch(/^preview-sessions\.json\.unreadable-/);
      const secondBytes = new TextEncoder().encode('{"version":2,"sessions":[]}');
      yield* fs.writeFile(file, secondBytes);
      const restarted = yield* Effect.scoped(create);
      const backups = yield* fs.readDirectory(config.stateDir);
      expect(backups).toHaveLength(2);
      const secondBackup = backups.find((name) => name !== firstBackup);
      expect(secondBackup).toMatch(/^preview-sessions\.json\.unreadable-/);
      expect(
        NodeBuffer.Buffer.compare(
          yield* fs.readFile(path.join(config.stateDir, firstBackup!)),
          firstBytes,
        ),
      ).toBe(0);
      expect(
        NodeBuffer.Buffer.compare(
          yield* fs.readFile(path.join(config.stateDir, secondBackup!)),
          secondBytes,
        ),
      ).toBe(0);
      const opened = yield* restarted.open({
        threadId: freshThreadId(),
        url: "https://example.com/new",
      });
      expect((yield* restarted.list({})).sessions).toEqual([opened]);
    }),
  );

  it.effect.each(["open", "navigate", "close"] as const)(
    "keeps durable and live state unchanged when an atomic %s save fails",
    (operation) =>
      Effect.gen(function* () {
        const config = yield* isolatedPersistenceConfig();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(config.stateDir, "preview-sessions.json");
        let failWrite = false;
        const guarded = FileSystem.make({
          ...fs,
          rename: (from, to) =>
            failWrite && to === file
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                  }),
                )
              : fs.rename(from, to),
        });
        const manager = yield* PreviewManager.make.pipe(
          Effect.provideService(ServerConfig.ServerConfig, config),
          Effect.provideService(FileSystem.FileSystem, guarded),
        );
        const threadId = freshThreadId();
        const original = yield* manager.open({ threadId, url: "https://example.com/original" });
        const before = yield* fs.readFileString(file);
        const subscription = yield* manager.subscribeEvents;
        failWrite = true;
        const change =
          operation === "open"
            ? manager.open({ threadId, url: "https://example.com/new" }).pipe(Effect.asVoid)
            : operation === "navigate"
              ? manager
                  .navigate({
                    threadId,
                    tabId: original.tabId,
                    url: "https://example.com/new",
                  })
                  .pipe(Effect.asVoid)
              : manager.close({ threadId, tabId: original.tabId });
        expect(yield* change.pipe(Effect.flip)).toMatchObject({
          _tag: "PreviewSessionStorageError",
        });
        expect((yield* manager.list({ threadId })).sessions).toEqual([original]);
        expect(yield* fs.readFileString(file)).toBe(before);
        expect(yield* PubSub.takeUpTo(subscription, DRAIN_LIMIT)).toEqual([]);
      }),
  );

  it.effect("creates an immutable native root outside the lock before publishing its tab", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const threadId = freshThreadId();
      const events = yield* collectEvents;
      const requested = yield* Deferred.make<void>();
      const created = yield* Deferred.make<void>();
      let canceled = true;
      const opening = yield* manager
        .open({
          threadId,
          runtime: "server",
          desktopHostId: "host-a",
          profileId: "work",
          automationOwner: "agent-a",
          url: "https://example.test/start",
          createDesktopRoot: (snapshot) =>
            Effect.gen(function* () {
              expect(snapshot).toMatchObject({
                backingPage: "desktop-root",
                desktopHostId: "host-a",
                profileId: "work",
                automationOwner: "agent-a",
              });
              expect((yield* manager.list({ threadId })).sessions).toEqual([]);
              yield* Deferred.succeed(requested, undefined);
              yield* Deferred.await(created);
              return {
                rootId: "root-a",
                publish: () => Effect.void,
                close: () =>
                  canceled
                    ? Effect.fail(
                        new PreviewNativeCloseError({ tabId: snapshot.tabId, reason: "canceled" }),
                      )
                    : Effect.void,
              };
            }),
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      expect(yield* events.drain).toEqual([]);
      // An unrelated open proceeds while the native creation callback is waiting.
      const ordinary = yield* manager.open({ threadId, runtime: "server" });
      expect((yield* events.drain).map((event) => event.tabId)).toEqual([ordinary.tabId]);
      yield* Deferred.succeed(created, undefined);
      const root = yield* Fiber.join(opening);
      expect(root).toMatchObject({ backingPage: "desktop-root", desktopRootId: "root-a" });
      expect(yield* events.drain).toEqual([
        expect.objectContaining({ type: "opened", snapshot: root }),
      ]);
      yield* manager.reportStatus({
        threadId,
        tabId: root.tabId,
        serverControlled: true,
        navStatus: { _tag: "Success", url: "https://example.test/next", title: "Next" },
        canGoBack: true,
        canGoForward: false,
      });
      yield* manager.resize({
        threadId,
        tabId: root.tabId,
        viewport: { _tag: "freeform", width: 900, height: 600 },
      });
      yield* manager.requestReveal({ threadId, tabId: root.tabId, force: true });
      expect(yield* manager.close({ threadId, tabId: root.tabId }).pipe(Effect.flip)).toMatchObject(
        { reason: "canceled" },
      );
      expect(
        (yield* manager.list({ threadId })).sessions.find(
          (session) => session.tabId === root.tabId,
        ),
      ).toMatchObject({
        backingPage: "desktop-root",
        desktopRootId: "root-a",
        desktopHostId: "host-a",
        profileId: "work",
        automationOwner: "agent-a",
        navStatus: { title: "Next" },
      });
      canceled = false;
      yield* manager.close({ threadId, tabId: root.tabId });
      expect((yield* manager.list({ threadId })).sessions).toEqual([ordinary]);
    }),
  );

  it.effect("abort during final publication retains the committed native tab without cleanup", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const threadId = freshThreadId();
      const events = yield* collectEvents;
      const publishing = yield* Deferred.make<void>();
      const finishPublishing = yield* Deferred.make<void>();
      let closed = 0;
      let prepared = false;
      const opening = yield* manager
        .open({
          threadId,
          runtime: "server",
          desktopHostId: "host-a",
          automationOwner: "agent-a",
          beforePublish: () => {
            prepared = true;
          },
          createDesktopRoot: () =>
            Effect.succeed({
              rootId: "committed-root",
              close: () =>
                Effect.sync(() => {
                  closed++;
                }),
              publish: () =>
                Effect.gen(function* () {
                  expect(prepared).toBe(true);
                  yield* Deferred.succeed(publishing, undefined);
                  yield* Deferred.await(finishPublishing);
                }),
            }),
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(publishing);
      const interruption = yield* Fiber.interrupt(opening).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(finishPublishing, undefined);
      yield* Fiber.join(interruption);
      expect(closed).toBe(0);
      expect((yield* manager.list({ threadId })).sessions).toEqual([
        expect.objectContaining({ backingPage: "desktop-root", desktopRootId: "committed-root" }),
      ]);
      expect(yield* events.drain).toEqual([expect.objectContaining({ type: "opened" })]);
    }),
  );

  it.effect("a failed pre-publication callback cancels the native attempt before publication", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const threadId = freshThreadId();
      const events = yield* collectEvents;
      let canceled = 0;
      let published = 0;
      yield* manager
        .open({
          threadId,
          runtime: "server",
          desktopHostId: "host-a",
          automationOwner: "agent-a",
          beforePublish: () => {
            throw new Error("registration failed");
          },
          createDesktopRoot: () =>
            Effect.succeed({
              rootId: "abandoned-root",
              close: () =>
                Effect.sync(() => {
                  canceled++;
                }),
              publish: () =>
                Effect.sync(() => {
                  published++;
                }),
            }),
        })
        .pipe(Effect.exit);
      expect(canceled).toBe(1);
      expect(published).toBe(0);
      expect((yield* manager.list({ threadId })).sessions).toEqual([]);
      expect(yield* events.drain).toEqual([]);
    }),
  );

  it.effect(
    "failed native creation publishes no tab and shared opens keep their current backing",
    () =>
      Effect.gen(function* () {
        const manager = yield* PreviewManager.PreviewManager;
        const threadId = freshThreadId();
        const events = yield* collectEvents;
        const createDesktopRoot = (snapshot: { readonly tabId: string }) =>
          Effect.fail(
            new PreviewNativeCreateError({
              tabId: snapshot.tabId,
              cause: new Error("unavailable"),
            }),
          );
        expect(
          yield* manager
            .open({
              threadId,
              runtime: "server",
              desktopHostId: "host-a",
              automationOwner: "agent-a",
              createDesktopRoot,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "PreviewNativeCreateError" });
        expect((yield* manager.list({ threadId })).sessions).toEqual([]);
        expect(yield* events.drain).toEqual([]);
        const shared = yield* manager.open({
          threadId,
          runtime: "server",
          desktopHostId: "host-a",
          createDesktopRoot,
        });
        expect(shared.backingPage).toBe("desktop");
        expect(shared.desktopRootId).toBeUndefined();
        const headless = yield* manager.open({
          threadId,
          runtime: "server",
          automationOwner: "agent-a",
          createDesktopRoot,
        });
        expect(headless.backingPage).toBe("server");
      }),
  );

  it.effect(
    "bulk close removes ordinary and confirmed tabs while retaining failed native tabs",
    () =>
      Effect.gen(function* () {
        const manager = yield* PreviewManager.PreviewManager;
        const threadId = freshThreadId();
        // Put a failed guard before the eligible tabs to exercise cleanup's bulk close.
        const failed = yield* manager.open({
          threadId,
          runtime: "server",
          desktopHostId: "host-a",
          automationOwner: "agent-a",
          desktopPopup: {
            popupId: "failed-native",
            close: () =>
              Effect.fail(
                new PreviewNativeCloseError({ tabId: "failed-native", reason: "unavailable" }),
              ),
          },
        });
        const ordinary = yield* manager.open({ threadId, runtime: "server" });
        let confirmed = false;
        const successful = yield* manager.open({
          threadId,
          runtime: "server",
          desktopHostId: "host-a",
          desktopPopup: {
            popupId: "confirmed-native",
            close: () =>
              Effect.sync(() => {
                confirmed = true;
              }),
          },
        });
        const events = yield* collectEvents;
        const failure = yield* manager.close({ threadId }).pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "PreviewNativeCloseError", reason: "unavailable" });
        expect(confirmed).toBe(true);
        expect((yield* manager.list({ threadId })).sessions).toEqual([failed]);
        expect((yield* events.drain).map((event) => event.tabId)).toEqual([
          ordinary.tabId,
          successful.tabId,
        ]);
      }),
  );

  it.effect(
    "native close preserves current state while acknowledgment waits outside the lock",
    () =>
      Effect.gen(function* () {
        const manager = yield* PreviewManager.PreviewManager;
        const threadId = freshThreadId();
        const requested = yield* Deferred.make<void>();
        const confirmed = yield* Deferred.make<void>();
        const popup = yield* manager.open({
          threadId,
          runtime: "server",
          desktopHostId: "host-a",
          automationOwner: "agent-a",
          desktopPopup: {
            popupId: "child-1",
            close: () =>
              Deferred.succeed(requested, undefined).pipe(
                Effect.andThen(Deferred.await(confirmed)),
              ),
          },
        });
        const closing = yield* manager
          .close({ threadId, tabId: popup.tabId })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(requested);
        yield* manager.reportStatus({
          threadId,
          tabId: popup.tabId,
          serverControlled: true,
          navStatus: {
            _tag: "Success",
            url: "https://signin.example.test/",
            title: "Updated while waiting",
          },
          canGoBack: false,
          canGoForward: false,
        });
        const retained = (yield* manager.list({ threadId })).sessions[0];
        expect(retained).toMatchObject({
          automationOwner: "agent-a",
          navStatus: { title: "Updated while waiting" },
        });
        yield* Deferred.succeed(confirmed, undefined);
        yield* Fiber.join(closing);
        expect((yield* manager.list({ threadId })).sessions).toEqual([]);
      }),
  );

  it.effect("canceled and unavailable native closes preserve their authoritative session", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      for (const reason of ["canceled", "unavailable"] as const) {
        const threadId = freshThreadId();
        const popup = yield* manager.open({
          threadId,
          runtime: "server",
          desktopHostId: "host-a",
          automationOwner: "agent-a",
          desktopPopup: {
            popupId: "child-1",
            close: () => Effect.fail(new PreviewNativeCloseError({ tabId: "child-1", reason })),
          },
        });
        const events = yield* collectEvents;
        const error = yield* manager.close({ threadId, tabId: popup.tabId }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "PreviewNativeCloseError", reason });
        expect((yield* manager.list({ threadId })).sessions).toEqual([popup]);
        expect(yield* events.drain).toEqual([]);
        yield* manager.nativeClosedConfirmed({ threadId, tabId: popup.tabId });
        expect((yield* manager.list({ threadId })).sessions).toEqual([]);
        expect(yield* events.drain).toEqual([
          expect.objectContaining({ type: "closed", tabId: popup.tabId }),
        ]);
      }
      const threadId = freshThreadId();
      const unknown = yield* manager.open({
        threadId,
        runtime: "server",
        desktopHostId: "host-a",
        desktopPopup: { popupId: "no-guard" },
      });
      const failure = yield* manager.close({ threadId, tabId: unknown.tabId }).pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PreviewNativeCloseError", reason: "unavailable" });
      expect((yield* manager.list({ threadId })).sessions).toEqual([unknown]);
    }),
  );

  it.effect("publishes one authoritative backing page before subscribers can attach", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const manager = yield* PreviewManager.make.pipe(
        Effect.provideService(ServerConfig.ServerConfig, {
          ...config,
          desktopBrowserFd: 4,
          desktopBrowserControlFd: 5,
        }),
      );
      const events = yield* manager.subscribeEvents;
      // Extra client properties cannot override the server's choice.
      const input = {
        threadId: freshThreadId(),
        runtime: "server" as const,
        backingPage: "server",
      };
      const local = yield* manager.open(input);
      const remote = yield* manager.open({
        threadId: input.threadId,
        runtime: "server",
        desktopHostId: "remote-desktop",
        profileId: "work",
      });
      const popup = yield* manager.open({
        threadId: input.threadId,
        runtime: "server",
        desktopHostId: "remote-desktop",
        profileId: "work",
        desktopPopup: { popupId: "native-child" },
      });
      expect(local).toMatchObject({ backingPage: "desktop", desktopHostId: "local" });
      expect(remote).toMatchObject({
        backingPage: "desktop",
        desktopHostId: "remote-desktop",
        profileId: "work",
      });
      expect(popup).toMatchObject({
        backingPage: "desktop-popup",
        desktopPopupId: "native-child",
        desktopHostId: "remote-desktop",
        profileId: "work",
      });
      const opened = yield* PubSub.takeUpTo(events, DRAIN_LIMIT);
      expect(opened.map((event) => ("snapshot" in event ? event.snapshot : null))).toEqual([
        local,
        remote,
        popup,
      ]);
      expect((yield* manager.list({ threadId: input.threadId })).sessions).toEqual([
        local,
        remote,
        popup,
      ]);
    }),
  );

  it.effect(
    "chooses headless without both local IPC descriptors and preserves explicit hosts",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        for (const desktopBrowserFd of [undefined, 4]) {
          const manager = yield* PreviewManager.make.pipe(
            Effect.provideService(ServerConfig.ServerConfig, {
              ...config,
              desktopBrowserFd,
              desktopBrowserControlFd: undefined,
            }),
          );
          const threadId = freshThreadId();
          const server = yield* manager.open({ threadId, runtime: "server" });
          expect(server.backingPage).toBe("server");
          expect(server.desktopHostId).toBeUndefined();
          const pinned = yield* manager.open({
            threadId,
            runtime: "server",
            desktopHostId: "local",
          });
          expect(pinned).toMatchObject({ backingPage: "desktop", desktopHostId: "local" });
        }
      }),
  );

  it.effect("an explicit environment choice remains headless with local native IPC available", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const manager = yield* PreviewManager.make.pipe(
        Effect.provideService(ServerConfig.ServerConfig, {
          ...config,
          desktopBrowserFd: 4,
          desktopBrowserControlFd: 5,
        }),
      );
      const threadId = freshThreadId();
      const opened = yield* manager.open({
        threadId,
        runtime: "server",
        environmentHosted: true,
        automationOwner: "agent-a",
      });
      expect(opened).toMatchObject({ backingPage: "server", automationOwner: "agent-a" });
      expect(opened.desktopHostId).toBeUndefined();
      expect((yield* manager.list({ threadId })).sessions).toEqual([opened]);
    }),
  );

  it.effect(
    "client environment selection publishes server backing despite native IPC and host defaults",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const manager = yield* PreviewManager.make.pipe(
          Effect.provideService(ServerConfig.ServerConfig, {
            ...config,
            desktopBrowserFd: 4,
            desktopBrowserControlFd: 5,
          }),
        );
        for (const profileId of ["default", "incognito"]) {
          const opened = yield* manager.open({
            threadId: freshThreadId(),
            browserHost: "environment",
            runtime: "desktop",
            desktopHostId: "selected-desktop",
            profileId,
            url: "http://127.0.0.1:5173/app?run=1#section",
          });
          expect(opened).toMatchObject({
            runtime: "server",
            backingPage: "server",
            profileId,
            navStatus: { url: "http://127.0.0.1:5173/app?run=1#section" },
          });
          expect(opened.desktopHostId).toBeUndefined();
        }
        const threadId = freshThreadId();
        const failure = yield* manager
          .open({
            threadId,
            browserHost: "environment",
            profileId: "work-account",
          })
          .pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: "PreviewProfileHostError",
          profileId: "work-account",
        });
        expect((yield* manager.list({ threadId })).sessions).toEqual([]);
      }),
  );

  it.effect("lists all environment tabs when the thread filter is omitted", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const firstThread = freshThreadId();
      const secondThread = freshThreadId();
      const first = yield* manager.open({ threadId: firstThread, runtime: "server" });
      const second = yield* manager.open({ threadId: secondThread, runtime: "server" });
      const all = yield* manager.list({});
      expect(all.sessions).toEqual(expect.arrayContaining([first, second]));
      const filtered = yield* manager.list({ threadId: firstThread });
      expect(filtered.sessions).toEqual([first]);
      expect(filtered.serverEpoch).toBe(all.serverEpoch);
      expect(filtered.revision).toBe(all.revision);
      yield* manager.close({ threadId: firstThread, tabId: first.tabId });
      const refreshed = yield* manager.list({});
      expect(refreshed.sessions.some((tab) => tab.tabId === first.tabId)).toBe(false);
      expect(refreshed.sessions).toContainEqual(second);
      expect(refreshed.revision).toBeGreaterThan(all.revision);
    }),
  );

  it.effect("shares durable recovery identity by thread and exact URL until a tab succeeds", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const first = yield* manager.claimRecovery({
        threadId: ThreadId.make("recovery-thread-a"),
        tabId: "tab-a",
        url: "http://localhost:5173/failed",
      });
      const sameClaimOtherTab = yield* manager.claimRecovery({
        threadId: ThreadId.make("recovery-thread-a"),
        tabId: "tab-b",
        url: "http://localhost:5173/failed",
      });
      const differentThread = yield* manager.claimRecovery({
        threadId: ThreadId.make("recovery-thread-b"),
        tabId: "tab-c",
        url: "http://localhost:5173/failed",
      });
      expect(sameClaimOtherTab).toEqual(first);
      expect(differentThread).not.toEqual(first);

      const tab = yield* manager.open({
        threadId: ThreadId.make("recovery-thread-a"),
        url: "http://localhost:5173/failed",
      });
      const originalClaim = yield* manager.claimRecovery({
        threadId: ThreadId.make("recovery-thread-a"),
        tabId: tab.tabId,
        url: "http://localhost:5173/redirected-from",
      });
      yield* manager.reportStatus({
        threadId: ThreadId.make("recovery-thread-a"),
        tabId: tab.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/final", title: "Ready" },
        canGoBack: true,
        canGoForward: false,
      });
      const afterSuccess = yield* manager.claimRecovery({
        threadId: ThreadId.make("recovery-thread-a"),
        tabId: tab.tabId,
        url: "http://localhost:5173/redirected-from",
      });
      expect(afterSuccess).not.toEqual(originalClaim);
    }),
  );

  it.effect("restores a recovery identity when the manager is reconstructed", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const threadId = ThreadId.make("recovery-restart-thread");
      const first = yield* manager.claimRecovery({
        threadId,
        tabId: "tab-before-restart",
        url: "http://localhost:5173/restart",
      });
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const restartedManager = yield* PreviewManager.make.pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const afterRestart = yield* restartedManager.claimRecovery({
        threadId,
        tabId: "tab-after-restart",
        url: "http://localhost:5173/restart",
      });
      expect(afterRestart).toEqual(first);
    }),
  );

  it.effect("keeps browser previews available when the recovery registry is unreadable", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.writeFileString(
        path.join(config.stateDir, "preview-recovery-claims.json"),
        "not valid recovery data",
      );
      const managerAfterCorruption = yield* PreviewManager.make.pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const claimResult = yield* Effect.exit(
        managerAfterCorruption.claimRecovery({
          threadId: ThreadId.make("corrupt-recovery-thread"),
          tabId: "tab-corrupt",
          url: "http://localhost:5173/corrupt",
        }),
      );
      expect(claimResult._tag).toBe("Failure");
      const opened = yield* manager.open({ threadId: ThreadId.make("browser-remains-available") });
      expect(opened.navStatus._tag).toBe("Idle");
    }),
  );
  it.effect("opens a session and emits opened with normalized URL", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const snapshot = yield* manager.open({ threadId, url: "localhost:5173" });
      expect(snapshot.tabId.startsWith("tab_")).toBe(true);
      expect(snapshot.navStatus._tag).toBe("Loading");
      if (snapshot.navStatus._tag === "Loading") {
        expect(snapshot.navStatus.url).toBe("http://localhost:5173/");
      }

      const events = yield* collector.drain;
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("opened");
      if (events[0]?.type === "opened") {
        expect(events[0].tabId).toBe(snapshot.tabId);
      }
    }),
  );

  it.effect("keeps the tab's profile across navigation and status reports", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;

      const opened = yield* manager.open({ threadId, profileId: "work" });
      expect(opened.profileId).toBe("work");

      const navigated = yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "localhost:5173",
      });
      expect(navigated.profileId).toBe("work");

      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Dev" },
        canGoBack: true,
        canGoForward: false,
      });
      const listed = yield* manager.list({ threadId });
      expect(listed.sessions.find((s) => s.tabId === opened.tabId)?.profileId).toBe("work");
    }),
  );

  it.effect("carries background focus intent in the opened event without hiding the tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const opened = yield* manager.open({
        threadId,
        runtime: "server",
        profileId: "source-profile",
        desktopHostId: "desktop-local",
        background: true,
      });
      expect(opened.reveal).toBeUndefined();
      expect(opened.automationOwner).toBeUndefined();
      expect(opened).toMatchObject({ profileId: "source-profile", desktopHostId: "desktop-local" });
      expect((yield* manager.list({ threadId })).sessions).toEqual([opened]);
      expect(yield* collector.drain).toEqual([
        expect.objectContaining({ type: "opened", background: true, snapshot: opened }),
      ]);
    }),
  );

  it.effect("echoes originating selection only in the creation event", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const focus = { clientId: "origin-client", userActionRevision: 7 };
      const threadId = freshThreadId();
      const opened = yield* manager.open({ threadId, focus });
      expect(yield* collector.drain).toEqual([expect.objectContaining({ type: "opened", focus })]);
      expect(opened).not.toHaveProperty("focus");
      expect((yield* manager.list({ threadId })).sessions[0]).not.toHaveProperty("focus");
      yield* manager.navigate({ threadId, tabId: opened.tabId, url: "https://example.test/" });
      expect((yield* collector.drain)[0]).not.toHaveProperty("focus");
    }),
  );

  it.effect("reissues presentation requests without replaying them on navigation", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const opened = yield* manager.open({ threadId, runtime: "server", reveal: false });
      yield* manager.requestReveal({ threadId, tabId: opened.tabId, force: true });
      const first = (yield* manager.list({ threadId })).sessions[0];
      expect(first?.reveal).toBe(true);
      expect(first?.revealRequest?.force).toBe(true);
      const refused = yield* manager
        .navigate({ threadId, tabId: opened.tabId, url: "localhost:5173" })
        .pipe(Effect.flip);
      expect(refused._tag).toBe("PreviewControlRequiredError");
      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        serverControlled: true,
        navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Dev" },
        canGoBack: false,
        canGoForward: false,
      });
      expect((yield* manager.list({ threadId })).sessions[0]?.revealRequest).toEqual(
        first?.revealRequest,
      );
      yield* manager.requestReveal({ threadId, tabId: opened.tabId, force: false });
      const second = (yield* manager.list({ threadId })).sessions[0];
      expect(second?.revealRequest?.id).not.toBe(first?.revealRequest?.id);
      expect(second?.revealRequest?.force).toBe(false);
      const events = yield* collector.drain;
      const last = events.at(-1);
      expect(last?.type).toBe("navigated");
      if (last?.type === "navigated")
        expect(last.snapshot.revealRequest).toEqual(second?.revealRequest);
    }),
  );

  it.effect("orders list snapshots and events with one monotonic revision", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const before = yield* manager.list({ threadId });

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:5173/ready",
      });

      const events = yield* collector.drain;
      const listed = yield* manager.list({ threadId });
      expect(events).toHaveLength(2);
      expect(events[0]!.serverEpoch).toBe(listed.serverEpoch);
      expect(events[1]!.serverEpoch).toBe(listed.serverEpoch);
      expect(events[0]!.revision).toBeGreaterThan(before.revision);
      expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
      expect(listed.revision).toBe(events[1]!.revision);
      expect(listed.sessions).toHaveLength(1);
    }),
  );

  it.effect("resizes a tab and preserves its viewport across navigation reports", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });

      const resized = yield* manager.resize({
        threadId,
        tabId: opened.tabId,
        viewport: { _tag: "freeform", width: 1024, height: 768 },
      });
      expect(resized.viewport).toEqual({ _tag: "freeform", width: 1024, height: 768 });

      const navigated = yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:5173/resized",
      });
      expect(navigated.viewport).toEqual(resized.viewport);

      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/resized", title: "Resized" },
        canGoBack: true,
        canGoForward: false,
      });
      const listed = yield* manager.list({ threadId });
      expect(listed.sessions[0]?.viewport).toEqual(resized.viewport);

      const events = yield* collector.drain;
      expect(events.map((event) => event.type)).toEqual([
        "opened",
        "resized",
        "navigated",
        "navigated",
      ]);
    }),
  );

  it.effect(
    "rejects client status reports for server tabs without changing state or emitting events",
    () =>
      Effect.gen(function* () {
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;
        const opened = yield* manager.open({ threadId, runtime: "server", reveal: false });
        const collector = yield* collectEvents;
        const before = yield* manager.list({ threadId });
        const input = {
          threadId,
          tabId: opened.tabId,
          navStatus: {
            _tag: "Success" as const,
            url: "http://localhost:5173/changed",
            title: "Changed",
          },
          canGoBack: true,
          canGoForward: true,
        };
        const rejected = yield* manager.reportStatus(input).pipe(Effect.flip);
        expect(rejected._tag).toBe("PreviewControlRequiredError");
        expect(yield* manager.list({ threadId })).toEqual(before);
        expect(yield* collector.drain).toEqual([]);

        yield* manager.reportStatus({ ...input, serverControlled: true });
        expect((yield* manager.list({ threadId })).sessions[0]).toMatchObject({
          navStatus: input.navStatus,
          canGoBack: true,
          canGoForward: true,
        });
        const events = yield* collector.drain;
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "navigated",
          snapshot: { navStatus: input.navStatus },
        });
      }),
  );

  it.effect("gives every tab in a batch close its own monotonic revision", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.open({ threadId, url: "http://localhost:3000" });
      const collector = yield* collectEvents;

      yield* manager.close({ threadId });

      const events = yield* collector.drain;
      const listed = yield* manager.list({ threadId });
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.type === "closed")).toBe(true);
      expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
      expect(listed.revision).toBe(events[1]!.revision);
      expect(listed.sessions).toHaveLength(0);
    }),
  );

  it.effect("close with explicit tabId removes only that tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const a = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const b = yield* manager.open({ threadId, url: "http://localhost:3000" });

      yield* manager.close({ threadId, tabId: a.tabId });

      const list = yield* manager.list({ threadId });
      expect(list.sessions.map((s) => s.tabId)).toEqual([b.tabId]);
    }),
  );
});
