import * as Schema from "effect/Schema";

import { PreviewAutomationProfiles } from "./previewAutomation.ts";

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

/** Desktop -> server. */
export const DESKTOP_BROWSER_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const DESKTOP_BROWSER_DOWNLOAD_CHUNK_BYTES = 192 * 1024;

export const DesktopBrowserEvent = Schema.Union([
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
  { reason: Schema.Literals(["host-unavailable", "download-transfer-failed"]) },
) {
  override get message(): string {
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
