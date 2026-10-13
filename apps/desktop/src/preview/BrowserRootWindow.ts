import { BrowserWindow } from "electron";
import * as Effect from "effect/Effect";
import { DesktopBrowserTransportError, type PreviewViewportSetting } from "@t3tools/contracts";

import type { BrowserSession } from "./BrowserSession.ts";
import type { resolvePartitionScope } from "./BrowserProfileScope.ts";

export const create = (
  sessions: BrowserSession["Service"],
  input: {
    readonly environmentId: string;
    readonly profileId: string;
    readonly viewport?: PreviewViewportSetting;
  },
  partition: ReturnType<typeof resolvePartitionScope>,
) =>
  Effect.gen(function* () {
    const { scope, persistent, namespace } = partition;
    const session = yield* sessions.getSession(scope, persistent, namespace);
    return yield* Effect.try(() => {
      const size =
        input.viewport && input.viewport._tag !== "fill"
          ? { width: input.viewport.width, height: input.viewport.height }
          : { width: 1024, height: 768 };
      const window = new BrowserWindow({
        show: false,
        focusable: false,
        skipTaskbar: true,
        useContentSize: true,
        ...size,
        webPreferences: {
          session,
          backgroundThrottling: true,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      try {
        if (window.webContents.session !== session)
          throw new Error("Native browser root did not retain the selected profile session.");
        window.webContents.setIgnoreMenuShortcuts(true);
        return window;
      } catch (cause) {
        window.destroy();
        throw cause;
      }
    });
  }).pipe(Effect.mapError(() => new DesktopBrowserTransportError({ reason: "guest-unavailable" })));
