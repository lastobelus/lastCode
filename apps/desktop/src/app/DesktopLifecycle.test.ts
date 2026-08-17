import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

describe("DesktopLifecycle", () => {
  for (const platform of ["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>) {
    it.effect(`lets the updater's quit event proceed on ${platform}`, () => {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();

      const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
        metadata: Effect.die("unexpected metadata read"),
        name: Effect.succeed("T3 Code"),
        systemLocale: Effect.succeed("en-US"),
        whenReady: Effect.void,
        quit: Effect.void,
        exit: () => Effect.void,
        relaunch: () => Effect.void,
        setPath: () => Effect.void,
        setName: () => Effect.void,
        setAboutPanelOptions: () => Effect.void,
        setAppUserModelId: () => Effect.void,
        getAppMetrics: Effect.succeed([]),
        isDefaultProtocolClient: () => Effect.succeed(false),
        setAsDefaultProtocolClient: () => Effect.succeed(true),
        setDesktopName: () => Effect.void,
        setDockIcon: () => Effect.void,
        appendCommandLineSwitch: () => Effect.void,
        removeCommandLineSwitch: () => Effect.void,
        onBeforeQuitForUpdate: (listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set("before-quit-for-update", listener);
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete("before-quit-for-update");
              }),
          ).pipe(Effect.asVoid),
        on: (eventName, listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set(
                eventName,
                listener as unknown as (...args: readonly unknown[]) => void,
              );
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete(eventName);
              }),
          ).pipe(Effect.asVoid),
      } satisfies ElectronApp.ElectronApp["Service"]);

      const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
        shouldUseDarkColors: Effect.succeed(false),
        setSource: () => Effect.void,
        onUpdated: () => Effect.void,
      });

      const desktopWindowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
        createMain: Effect.die("unexpected window creation"),
        ensureMain: Effect.die("unexpected window creation"),
        revealOrCreateMain: Effect.die("unexpected window creation"),
        activate: Effect.void,
        createMainIfBackendReady: Effect.void,
        showConnectingSplash: Effect.void,
        handleBackendReady: () => Effect.void,
        handleBackendNotReady: Effect.void,
        flushMainWindowBounds: Effect.void,
        dispatchMenuAction: () => Effect.void,
        zoomMain: () => Effect.void,
        runningActionCount: Effect.succeed(0),
        reportRunningActionCount: () => Effect.void,
        acknowledgeRunningActionQuitWarning: Effect.void,
        consumeRunningActionQuitWarningAcknowledgment: Effect.succeed(false),
        syncAppearance: Effect.void,
      });

      const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(electronAppLayer),
        Layer.provideMerge(ElectronDialog.layer),
        Layer.provideMerge(electronThemeLayer),
        Layer.provideMerge(desktopWindowLayer),
        Layer.provideMerge(environmentLayer),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit-for-update")?.();

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    });
  }

  it.effect("warns with the running Action count before quitting", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const shownOptions = yield* Deferred.make<Electron.MessageBoxOptions>();
      const dialogResponse = yield* Deferred.make<Electron.MessageBoxReturnValue>();
      const quitCalled = yield* Deferred.make<void>();

      const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
        metadata: Effect.die("unexpected metadata read"),
        name: Effect.succeed("T3 Code"),
        systemLocale: Effect.succeed("en-US"),
        whenReady: Effect.void,
        quit: Deferred.succeed(quitCalled, undefined).pipe(Effect.asVoid),
        exit: () => Effect.void,
        relaunch: () => Effect.void,
        setPath: () => Effect.void,
        setName: () => Effect.void,
        setAboutPanelOptions: () => Effect.void,
        setAppUserModelId: () => Effect.void,
        getAppMetrics: Effect.succeed([]),
        isDefaultProtocolClient: () => Effect.succeed(false),
        setAsDefaultProtocolClient: () => Effect.succeed(true),
        setDesktopName: () => Effect.void,
        setDockIcon: () => Effect.void,
        appendCommandLineSwitch: () => Effect.void,
        removeCommandLineSwitch: () => Effect.void,
        onBeforeQuitForUpdate: (listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set("before-quit-for-update", listener);
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete("before-quit-for-update");
              }),
          ).pipe(Effect.asVoid),
        on: (eventName, listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set(
                eventName,
                listener as unknown as (...args: readonly unknown[]) => void,
              );
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete(eventName);
              }),
          ).pipe(Effect.asVoid),
      } satisfies ElectronApp.ElectronApp["Service"]);

      const electronDialogLayer = Layer.succeed(ElectronDialog.ElectronDialog, {
        pickFolder: () => Effect.die("unexpected folder picker"),
        pickFiles: () => Effect.die("unexpected file picker"),
        showMessageBox: (options) =>
          Deferred.succeed(shownOptions, options).pipe(
            Effect.andThen(Deferred.await(dialogResponse)),
          ),
        showErrorBox: () => Effect.die("unexpected error dialog"),
      });

      const desktopWindowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
        createMain: Effect.die("unexpected window creation"),
        ensureMain: Effect.die("unexpected window creation"),
        revealOrCreateMain: Effect.die("unexpected window creation"),
        activate: Effect.void,
        createMainIfBackendReady: Effect.void,
        showConnectingSplash: Effect.void,
        handleBackendReady: () => Effect.void,
        handleBackendNotReady: Effect.void,
        flushMainWindowBounds: Effect.void,
        dispatchMenuAction: () => Effect.void,
        zoomMain: () => Effect.void,
        runningActionCount: Effect.succeed(3),
        reportRunningActionCount: () => Effect.void,
        acknowledgeRunningActionQuitWarning: Effect.void,
        consumeRunningActionQuitWarningAcknowledgment: Effect.succeed(false),
        syncAppearance: Effect.void,
      });

      const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(electronAppLayer),
        Layer.provideMerge(electronDialogLayer),
        Layer.provideMerge(
          Layer.succeed(ElectronTheme.ElectronTheme, {
            shouldUseDarkColors: Effect.succeed(false),
            setSource: () => Effect.void,
            onUpdated: () => Effect.void,
          }),
        ),
        Layer.provideMerge(desktopWindowLayer),
        Layer.provideMerge(environmentLayer),
        Layer.provideMerge(
          Layer.succeed(DesktopShutdown.DesktopShutdown, {
            request: Effect.void,
            awaitRequest: Effect.void,
            markComplete: Effect.void,
            awaitComplete: Effect.void,
            isComplete: Effect.succeed(true),
          }),
        ),
        Layer.provideMerge(DesktopState.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          let prevented = false;
          appListeners.get("before-quit")?.({
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event);

          const options = yield* Deferred.await(shownOptions);
          assert.isTrue(prevented);
          assert.equal(options.title, "Running Actions");
          assert.equal(options.message, "Quit and cancel 3 running Actions?");
          assert.equal(options.detail, "The commands will not be restarted automatically.");
          assert.deepEqual(options.buttons, ["Quit and cancel", "Keep running"]);

          yield* Deferred.succeed(dialogResponse, {
            response: 0,
            checkboxChecked: false,
          });
          yield* Deferred.await(quitCalled);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});
