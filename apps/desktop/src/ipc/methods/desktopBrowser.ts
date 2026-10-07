import { DesktopBrowserCommandInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopBrowserHost from "../../preview/DesktopBrowserHost.ts";
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

export const installBrowserEventForwarding = Effect.gen(function* () {
  const host = yield* DesktopBrowserHost.DesktopBrowserHost;
  const window = yield* ElectronWindow.ElectronWindow;
  yield* host.remoteEvents.pipe(
    Stream.runForEach((event) => window.sendAll(IpcChannels.DESKTOP_BROWSER_EVENT_CHANNEL, event)),
    Effect.forkScoped({ startImmediately: true }),
  );
});
