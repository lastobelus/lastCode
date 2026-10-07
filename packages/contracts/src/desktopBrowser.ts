import * as Schema from "effect/Schema";

import { PreviewAutomationProfiles } from "./previewAutomation.ts";
import { PreviewViewportSetting } from "./preview.ts";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Native browser CDP transport. The primary backend uses inherited file
 * descriptors; remote environments use authenticated command/event RPCs.
 * Every remote connection owns a distinct desktop host ID and its tab keys.
 * The server runs automation; Electron relays only its own tab debugger.
 */

const TabKey = {
  threadId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
};

const SurfaceViewport = Schema.Struct({
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
const SurfaceResponse = {
  requestId: Schema.String,
  viewport: Schema.NullOr(SurfaceViewport),
  reason: Schema.optionalKey(Schema.Literals(["guest-unavailable", "layout-timeout"])),
};
const SurfaceRequest = {
  type: Schema.Literal("surface"),
  ...TabKey,
  requestId: Schema.String,
  leaseId: Schema.String,
  action: Schema.Literals(["acquire", "release"]),
  viewport: Schema.optionalKey(PreviewViewportSetting),
  timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
};

/** Native renderer readiness, shared by the local and remote browser transports. */
export const DesktopBrowserSurfaceRequest = Schema.Struct({
  ...SurfaceRequest,
  runtimeTabId: Schema.String,
});
export type DesktopBrowserSurfaceRequest = typeof DesktopBrowserSurfaceRequest.Type;
export const DesktopBrowserSurfaceResponse = Schema.Struct(SurfaceResponse);
export type DesktopBrowserSurfaceResponse = typeof DesktopBrowserSurfaceResponse.Type;

/** Desktop -> server. */
export const DESKTOP_BROWSER_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const DESKTOP_BROWSER_DOWNLOAD_CHUNK_BYTES = 192 * 1024;

export const DesktopBrowserEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("surfaceReady"), ...TabKey, ...SurfaceResponse }),
  Schema.Struct({
    type: Schema.Literal("resolvedUrl"),
    requestId: Schema.String,
    url: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("download"),
    ...TabKey,
    guid: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/)),
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    data: Schema.String.check(Schema.isMaxLength((DESKTOP_BROWSER_DOWNLOAD_CHUNK_BYTES * 4) / 3)),
    done: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("profiles"),
    requestId: Schema.String,
    profiles: Schema.NullOr(PreviewAutomationProfiles),
  }),
  /** A desktop `<webview>` for this server tab is attached and can be driven. */
  Schema.Struct({ type: Schema.Literal("attached"), ...TabKey }),
  /** Its `<webview>` went away: closed, crashed, swapped, or devtools took the debugger. */
  Schema.Struct({ type: Schema.Literal("detached"), ...TabKey }),
  /** One CDP message from the tab's relay. */
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
]);
export type DesktopBrowserEvent = typeof DesktopBrowserEvent.Type;

/** Server -> desktop. */
export const DesktopBrowserCommand = Schema.Union([
  Schema.Struct(SurfaceRequest),
  Schema.Struct({
    type: Schema.Literal("resolveUrl"),
    requestId: Schema.String,
    url: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("announce") }),
  Schema.Struct({ type: Schema.Literal("disconnect") }),
  Schema.Struct({ type: Schema.Literal("profiles"), requestId: Schema.String }),
  /** One CDP message for the tab's relay. */
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  /** The server stopped driving this tab, so the relay can drop its sessions. */
  Schema.Struct({ type: Schema.Literal("release"), ...TabKey }),
  /** Where an agent action is about to land, so the desktop draws its cursor there. */
  Schema.Struct({
    type: Schema.Literal("pointer"),
    ...TabKey,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
  }),
]);
export type DesktopBrowserCommand = typeof DesktopBrowserCommand.Type;

export class DesktopBrowserTransportError extends Schema.TaggedError<DesktopBrowserTransportError>()(
  "DesktopBrowserTransportError",
  {
    reason: Schema.Literals([
      "host-unavailable",
      "download-transfer-failed",
      "layout-timeout",
      "guest-unavailable",
    ]),
  },
) {
  override get message(): string {
    if (this.reason === "layout-timeout")
      return "The desktop browser did not finish applying its viewport before the readiness deadline.";
    if (this.reason === "guest-unavailable")
      return "The desktop browser surface is not attached or stopped rendering.";
    return this.reason === "host-unavailable"
      ? "The selected desktop browser host is unavailable."
      : "The desktop browser download could not be transferred to this environment.";
  }
}

export const DesktopBrowserHostInput = Schema.Struct({ desktopHostId: TrimmedNonEmptyString });
export const DesktopBrowserEventInput = Schema.Struct({
  desktopHostId: TrimmedNonEmptyString,
  event: DesktopBrowserEvent,
});
export const DesktopBrowserCommandInput = Schema.Struct({
  desktopHostId: TrimmedNonEmptyString,
  command: DesktopBrowserCommand,
});
