import {
  DesktopBrowserCommandInput,
  DesktopBrowserSurfaceResponse,
  DesktopBrowserPresentationInput,
  DesktopBrowserTransportError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopBrowserHost from "../../preview/DesktopBrowserHost.ts";
import * as BrowserProfileScope from "../../preview/BrowserProfileScope.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export const browserCommand = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_BROWSER_COMMAND_CHANNEL,
  payload: DesktopBrowserCommandInput,
  result: Schema.Void,
  handler: (input) =>
    Effect.flatMap(DesktopBrowserHost.DesktopBrowserHost, (host) =>
      host.handleRemoteCommand(input),
    ),
});

export const browserEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_BROWSER_ENVIRONMENT_CHANNEL,
  payload: Schema.Struct({ desktopHostId: Schema.String, environmentId: Schema.String }),
  result: Schema.Void,
  handler: Effect.fn("desktop.browser.bindEnvironment")(function* ({
    desktopHostId,
    environmentId,
  }) {
    const host = yield* DesktopBrowserHost.DesktopBrowserHost;
    const context =
      yield* Effect.context<
        Effect.Services<ReturnType<typeof BrowserProfileScope.browserProfileScope>>
      >();
    return yield* host.bindEnvironment(desktopHostId, environmentId, (profileId) =>
      BrowserProfileScope.browserProfileScope(environmentId, profileId).pipe(
        Effect.provide(context),
        Effect.mapError(() => new DesktopBrowserTransportError({ reason: "profile-unavailable" })),
      ),
    );
  }),
});

export const browserSurfaceResponse = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_BROWSER_SURFACE_RESPONSE_CHANNEL,
  payload: DesktopBrowserSurfaceResponse,
  result: Schema.Void,
  handler: (response, event) =>
    Effect.flatMap(DesktopBrowserHost.DesktopBrowserHost, (host) =>
      Effect.sync(() => {
        if (event) host.surfaceResponse(response, event.sender.id);
      }),
    ),
});

export const browserPresentation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_BROWSER_PRESENTATION_CHANNEL,
  payload: DesktopBrowserPresentationInput,
  result: Schema.Void,
  handler: (input, event) =>
    Effect.flatMap(DesktopBrowserHost.DesktopBrowserHost, (host) =>
      Effect.sync(() => {
        if (event) host.setPresentation(input, event.sender.id);
      }),
    ),
});

export const installBrowserEventForwarding = Effect.gen(function* () {
  const host = yield* DesktopBrowserHost.DesktopBrowserHost;
  const window = yield* ElectronWindow.ElectronWindow;
  yield* host.remoteEvents.pipe(
    Stream.runForEach((event) => window.sendAll(IpcChannels.DESKTOP_BROWSER_EVENT_CHANNEL, event)),
    Effect.forkScoped({ startImmediately: true }),
  );
});
