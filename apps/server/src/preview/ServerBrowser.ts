// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.
import { installThreadLinkNavigation } from "./ThreadLinkNavigation.ts";
// Screencasts ignore emulated device scale; real 2x keeps captures sharp.
// --disable-gpu uses cheaper software compositing while preserving SwiftShader WebGL.
import {
  BrowserProfile,
  BrowserProfileId,
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
  FILL_PREVIEW_VIEWPORT,
  findBrowserProfile,
  INCOGNITO_BROWSER_PROFILE_ID,
  isBuiltInBrowserProfileId,
  resolveBrowserProfiles,
  type PreviewReportProfilesInput,
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
  PreviewViewportSetting as PreviewViewportSettingSchema,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type PreviewAutomationActionEvent,
  type PreviewAutomationClickInput,
  type PreviewAutomationDialogInput,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationDragInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationHoverInput,
  type PreviewAutomationLoadError,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationRequest,
  type PreviewAutomationResizeInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSelectInput,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationSnapshotInput,
  type PreviewAutomationStatus,
  type PreviewAutomationTypeInput,
  type PreviewAutomationUploadInput,
  type PreviewAutomationWaitForInput,
  DesktopBrowserTransportError,
  DESKTOP_BROWSER_INPUT_SOURCE_PARAM,
  PreviewClearProfileError,
  PreviewNativeCloseError,
  PreviewNativeCreateError,
  type PreviewEvent,
  type PreviewNavStatus,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
  ThreadId,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  type PreviewAppearancePreference,
  type PreviewZoomFactor,
} from "@t3tools/contracts";
import { AgentScope, agentScopeLauncherScript } from "@t3tools/shared/AgentScope";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as Mime from "effect/http/Mime";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import { constVoid } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type {
  BrowserContext,
  CDPSession,
  Dialog,
  Download,
  FileChooser,
  Frame,
  Page,
} from "playwright-core";

import { PENDING_ATTACHMENT_THREAD_SEGMENT } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as AssetAccess from "../assets/AssetAccess.ts";
import * as AssetSigner from "../assets/AssetSigner.ts";
import { resolveRootCliCommand } from "../cli/invocation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as PreviewManager from "./Manager.ts";
import * as PreviewHosting from "./Hosting.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";
import { presentAsChrome, ServerBrowserContexts } from "./ServerBrowserContexts.ts";
import { BrowserControlInterrupted, SessionControl } from "./SessionControl.ts";
import { createPdfDocumentNavigation, isPdfAssetUrl } from "./PdfDocumentNavigation.ts";

const SERVER_HOST_CLIENT_ID = SERVER_BROWSER_AUTOMATION_CLIENT_ID;
// Each client's report is capped, but the saved catalog is their union, so it has no cap.
const SavedProfilesJson = Schema.fromJsonString(
  Schema.Struct({ profiles: Schema.Array(BrowserProfile), defaultProfileId: BrowserProfileId }),
);
const decodeSavedProfiles = Schema.decodeUnknownEffect(SavedProfilesJson);
const encodeSavedProfiles = Schema.encodeSync(SavedProfilesJson);
const RENDER_SCALE = 2;
// Chromium allows three unacked frames, so 100 ms pacing caps viewers near 30 fps.
const SCREENCAST_ACK_PACE_MS = 100;
const SCREENCAST_SETTLE_MS = 200;
const SCREENCAST_MOTION_FRAMES = 4;
const SCREENCAST_MOTION_WINDOW_MS = 300;
const SCREENCAST_MOTION_QUALITY = 50;
const HOST_RECONNECT_DELAY = "1 second";
/** How long a desktop-backed tab waits for its selected native host to attach. */
const DESKTOP_ATTACH_TIMEOUT = "45 seconds";
// A viewer still is best-effort; a capture Chromium never answers must not hold the capture lock.
const VIEWER_STILL_TIMEOUT_MS = 2_000;
const VIEWER_OUTPUT_LIMIT = 64;
const RECORDING_SCREENCAST = { format: "jpeg", quality: 90, everyNthFrame: 1 } as const;
const RECORDING_BINARY_EXPORT_MIN_BYTES = 8 * 1024 * 1024;
const RECORDING_DOWNLOAD_TIMEOUT_MS = 5_000;
const decodeViewportSetting = Schema.decodeUnknownSync(PreviewViewportSettingSchema);
const isDesktopBrowserTransportError = Schema.is(DesktopBrowserTransportError);
const isBrowserControlInterrupted = Schema.is(BrowserControlInterrupted);
const isPreviewNativeCreateError = Schema.is(PreviewNativeCreateError);
/** The agent cursor glides to its target, then pulses just before the press, like desktop tabs. */
const AGENT_CURSOR_MOVE_MS = 160;
const AGENT_CURSOR_CLICK_LEAD_MS = 40;
/** A dialog blocks page script, so a desktop size read gives up after this. */
const DESKTOP_VIEWPORT_READ_TIMEOUT = "1 second";
/** A desktop page that keeps its size draws nothing on a resize, so the wait gives up. */
const DESKTOP_RESIZE_WAIT_MS = 1000;
// A revealed tab's client opens the panel and attaches its stream a few round trips later, remote ones included.
const REVEAL_VIEWER_WAIT_MS = 1000;

const sleepUntil = (deadline: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())));

const awaitViewer = async (tab: ServerTab, timeoutMs: number) => {
  const attached = (tab.viewerAttached ??= Promise.withResolvers());
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    attached.promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, timeoutMs));
    }),
  ]);
  clearTimeout(timer);
};

const EDITABLE_AT_POINT_SCRIPT = `(x, y) => {
  let element = document.elementFromPoint(x, y);
  while (element && element.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  if (element && element.tagName === "LABEL" && element.control) element = element.control;
  if (!element) return false;
  if (element.tagName === "IFRAME" || element.tagName === "FRAME") return true;
  if (element.isContentEditable) return true;
  if (element.tagName === "TEXTAREA") return !element.disabled && !element.readOnly;
  if (element.tagName !== "INPUT") return false;
  const nonText = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
  return !nonText.includes(element.type) && !element.disabled && !element.readOnly;
}`;
const UNATTACHED_FILL_VIEWPORT = { width: 1280, height: 800 } as const;
const NAVIGATION_TIMEOUT_MS = 15_000;
// Status reads run in the renderer; a busy page must not hold a status past the broker's grace.
const STATUS_READ_MS = 250;
const VIEWER_NAVIGATION_OPTIONS = { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS } as const;
const ACTION_TIMELINE_LIMIT = 50;

export class ServerBrowserTabNotFoundError extends Schema.TaggedError<ServerBrowserTabNotFoundError>()(
  "ServerBrowserTabNotFoundError",
  { threadId: Schema.String, tabId: Schema.String },
) {
  override get message(): string {
    return "The server preview tab does not exist.";
  }
}

const isTabNotFound = Schema.is(ServerBrowserTabNotFoundError);
const isHostSetupError = Schema.is(
  Schema.Union([
    PreviewBrowserHost.PreviewBrowserSandboxError,
    PreviewBrowserHost.PreviewBrowserLibrariesError,
    PreviewBrowserHost.PreviewBrowserRootError,
  ]),
);

class ServerBrowserDownloadsCleanupError extends Schema.TaggedError<ServerBrowserDownloadsCleanupError>()(
  "ServerBrowserDownloadsCleanupError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The server preview could not clear earlier downloads.";
  }
}

export class ServerBrowserLaunchError extends Schema.TaggedError<ServerBrowserLaunchError>()(
  "ServerBrowserLaunchError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The server preview browser could not start.";
  }
}

export type ServerBrowserViewerOutput =
  | {
      readonly _tag: "frame";
      readonly data: Uint8Array;
      readonly ack: Effect.Effect<void>;
    }
  | { readonly _tag: "viewport"; readonly width: number; readonly height: number }
  | {
      readonly _tag: "control";
      readonly canOperate: boolean;
      readonly controller: "agent" | "you" | "taking-control" | "another-viewer" | "unclaimed";
      readonly generation: number;
      readonly dialog: {
        readonly type: string;
        readonly message: string;
        readonly defaultValue: string;
      } | null;
    }
  | {
      readonly _tag: "probe";
      readonly x: number;
      readonly y: number;
      readonly editable: boolean;
    }
  | { readonly _tag: "clipboard"; readonly text: string }
  | {
      readonly _tag: "pointer";
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
      readonly sequence: number;
    }
  | {
      readonly _tag: "fileChooser";
      readonly id: string;
      readonly multiple: boolean;
      readonly accept: string;
    }
  | { readonly _tag: "fileChooserClosed"; readonly id: string }
  | { readonly _tag: "popup"; readonly tabId: string }
  | { readonly _tag: "threadLink"; readonly href: string }
  | {
      readonly _tag: "download";
      readonly id: string;
      readonly fileName: string;
      readonly sizeBytes: number;
    }
  | { readonly _tag: "gone" }
  | { readonly _tag: "reconnect" };

export interface ServerBrowserViewer {
  readonly output: Queue.Dequeue<ServerBrowserViewerOutput>;
  readonly input: (message: unknown) => Effect.Effect<void>;
}

export type ProfileReporter = (input: PreviewReportProfilesInput) => Effect.Effect<void>;

export class ServerBrowser extends Context.Service<
  ServerBrowser,
  {
    readonly attachViewer: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly maxWidth: number;
      readonly maxHeight: number;
      readonly quality: number;
      readonly canOperate: boolean;
    }) => Effect.Effect<
      ServerBrowserViewer,
      ServerBrowserTabNotFoundError | ServerBrowserLaunchError,
      Scope.Scope
    >;

    readonly answerFileChooser: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly chooserId: string;
      readonly files: ReadonlyArray<{
        readonly name: string;
        readonly mimeType: string;
        readonly buffer: Buffer;
      }>;
    }) => Effect.Effect<boolean>;
    readonly openDownload: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly downloadId: string;
    }) => Effect.Effect<Option.Option<{ readonly path: string; readonly fileName: string }>>;

    readonly clearProfile: (profileId: string) => Effect.Effect<void, PreviewClearProfileError>;

    readonly profileReporter: Effect.Effect<ProfileReporter, never, Scope.Scope>;
  }
>()("t3/preview/ServerBrowser") {}

interface ViewerState {
  readonly id: string;
  readonly canOperate: boolean;
  readonly pressedKeys: Map<string, { key: string; code: string }>;
  readonly pressedButtons: Map<"left" | "middle" | "right", { x: number; y: number }>;
  readonly push: (output: ServerBrowserViewerOutput) => void;
  readonly pause: (signal?: AbortSignal, timeoutMs?: number) => Promise<void>;
  readonly resume: (timeoutMs?: number) => Promise<void>;
  scrolledAt: number;
  /** Panel bounds survive fixed mode and control release; passive viewers never request a size. */
  requestedSize: { width: number; height: number; order: number } | null;
}

interface EncoderWindow {
  __t3Recorder: {
    cursor(x: number, y: number, click: boolean): void;
    frame(data: string, width: number): Promise<boolean>;
    stop(): Promise<{ mimeType: string | null; count: number; bytes: number }>;
    chunk(index: number): Promise<string>;
    download(): void;
  };
}

interface Recording {
  readonly encoder: Page;
  readonly session: CDPSession;
  readonly startedAt: string;
  readonly framesInFlight: Set<Promise<void>>;
  readonly releaseSurface: () => Promise<void>;
}

interface ServerTab {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly frameSessions: Map<Frame, CDPSession>;
  /** Copy reads run in key order, outside the input queue. */
  copyReads: Promise<void>;
  /** When the last copy or cut key was acknowledged; the next one starts after it. */
  copyKeyedUntil: number;
  readonly createdAt: number;
  usedAt: number;
  readonly viewers: Set<ViewerState>;
  viewerAttached: PromiseWithResolvers<void> | null;
  readonly consoleEntries: Array<PreviewAutomationConsoleEntry>;
  readonly networkEntries: Array<PreviewAutomationNetworkEntry>;
  readonly actionTimeline: Array<PreviewAutomationActionEvent>;
  readonly control: SessionControl;
  agentOperating: boolean;
  threadLinkViewer: ViewerState | null;
  pageActivity: number;
  readonly hostingActivityId: string;
  frozen: boolean;
  lifecycle: Promise<void>;
  fileChooserIntercepted: boolean;
  readonly onFileChooser: (chooser: FileChooser) => void;

  readonly isolatedContext: boolean;

  readonly desktop: { readonly close: () => Promise<void> } | null;
  readonly profileId: string | undefined;
  readonly desktopHostId: string | undefined;
  readonly backingPage: PreviewSessionSnapshot["backingPage"];
  nativePresented: boolean;
  revealRequested: boolean;
  readonly openerTabId: string | undefined;

  readonly downloads: Array<ServerDownload>;
  /** Browser destinations mapped to the owned local listener for later navigation. */
  readonly hostedOrigins: Map<string, string>;
  // Native adoption has no baseline yet; null remembers a rendered legacy run without an id.
  hostedRunId: string | null | undefined;
  hostedRunOrigin: string | undefined;
  /** Pending viewer preparation; replacement and control handoff cancel it. */
  viewerNavigation: AbortController | null;
  /**
   * A page's open file picker, waiting for the controlling viewer's files. Its
   * id is reissued for each viewer it is offered to, so only that viewer can answer.
   */
  fileChooser: {
    readonly id: string;
    readonly chooser: FileChooser;
    readonly accept: string;
    readonly offeredTo: string | null;
  } | null;
  dialog: Dialog | null;
  setting: PreviewViewportSetting;
  colorScheme: PreviewAppearancePreference;
  zoomFactor: PreviewZoomFactor;
  /** Last usable CSS size measured on the desktop. */
  desktopViewport: { readonly width: number; readonly height: number } | null;
  desktopViewportRead: Promise<ServerTab["desktopViewport"]>;
  /** A read queued behind `desktopViewportRead`, shared by every caller that waits for it. */
  desktopViewportNext: Promise<ServerTab["desktopViewport"]> | null;
  /** A page resize or load since the last read started; status measures again. */
  desktopViewportStale: boolean;
  /** Counts page resizes, loads and dialog closes, so a caller can tell one landed during a read. */
  desktopViewportChanges: number;
  /** Settles at the desktop page's next main-frame resize. */
  desktopResize: PromiseWithResolvers<void>;
  loading: boolean;
  loadError: PreviewAutomationLoadError | undefined;
  /** The renderer crash this page died of, or the one the page it replaced died of. */
  crash: PreviewAutomationLoadError | undefined;
  /** What Reload loads after a crash; the reported URL is shortened and drops data payloads. */
  crashedUrl: string | undefined;
  navigationSequence: number;
  latestNavigationStatus: PreviewNavStatus;
  navigationFailed: boolean;
  closing: boolean;
  recording: Recording | null;
  initialNavigation: Promise<void> | null;
  pendingInitialRequestUrl: string | null;
  navigationReady: Promise<void>;
  navigationGeneration: number;
  stoppedGeneration: number | null;

  abortedNavigation: {
    readonly url: string;
    readonly generation: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null;

  recordingStart: Promise<Recording> | null;
  captureLock: Promise<void>;
  capturing: number;
}

interface ServerDownload {
  readonly id: string;
  readonly fileName: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly completedAt: string;
}

/** Read-only operations remain available during human control; evaluate requires control because scripts can mutate the page. */
const READ_OPERATIONS: ReadonlySet<PreviewAutomationRequest["operation"]> = new Set([
  "status",
  "snapshot",
  "waitFor",
]);

const AGENT_TAB_LIMIT = 8;
const SERVER_TAB_LIMIT = 32;
const AGENT_TAB_IDLE_MS = 30 * 60 * 1000;
const PAGE_IDLE_MS = 24 * 60 * 60 * 1000;
const IDLE_SWEEP_INTERVAL = "1 minute";

const DOWNLOAD_LIMIT = 20;
const ABORTED_NAVIGATION_DOWNLOAD_WAIT_MS = 5_000;
const PAGE_CLOSE_GRACE_MS = 5_000;
const DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;

const tabKey = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;

const pushBounded = <A>(
  buffer: Array<A>,
  entry: A,
  limit = ServerBrowserPage.DIAGNOSTIC_BUFFER_LIMIT,
) => {
  buffer.push(entry);
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
};

const viewportSettingsEqual = (left: PreviewViewportSetting, right: PreviewViewportSetting) =>
  left._tag === right._tag &&
  (left._tag === "fill" ||
    (right._tag !== "fill" && left.width === right.width && left.height === right.height));

const fixedViewportSize = (setting: PreviewViewportSetting) =>
  setting._tag === "fill" ? null : { width: setting.width, height: setting.height };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const num = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const modifiersOf = (message: Record<string, unknown>) => {
  const value = num(message.modifiers);
  return Number.isInteger(value) && value >= 0 && value < 16 ? value : 0;
};

// Linux/headless Chromium needs commands for Cmd editing shortcuts and Ctrl copy/cut.
const editingCommand = (key: string, modifiers: number) => {
  const modifier = modifiers & 0b0111;
  if (modifier !== 2 && modifier !== 4) return null;
  const lower = key.toLowerCase();
  const command =
    lower === "c"
      ? "copy"
      : lower === "x"
        ? "cut"
        : modifier !== 4
          ? null
          : lower === "a"
            ? "selectAll"
            : lower === "z"
              ? modifiers & 8
                ? "redo"
                : "undo"
              : null;
  return command ? { commands: [command] } : null;
};

const CLIPBOARD_TEXT_LIMIT = 1024 * 1024;
const CLIPBOARD_WORLD = "t3-preview-clipboard";
// Chromium shares its clipboard across contexts; capture real copy/cut keys in a page-inaccessible world instead.
const CLIPBOARD_SCRIPT = `(() => {
  let keying = false;
  // One entry per copy or cut key, oldest first, so a later key cannot overwrite an unread copy.
  const copies = [];
  // The same Ctrl or Cmd + C or X that editingCommand sends as copy or cut.
  addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.altKey || event.ctrlKey === event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key !== "c" && key !== "x") return;
    keying = true;
    copies.push({ at: Date.now(), text: "" });
    setTimeout(() => { keying = false; });
  }, true);
  const selection = () => {
    let field = document.activeElement;
    while (field?.shadowRoot?.activeElement) field = field.shadowRoot.activeElement;
    if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.selectionStart !== null)
      return field.value.slice(field.selectionStart, field.selectionEnd ?? field.selectionStart);
    return String(document.getSelection() ?? "");
  };
  const record = (text) => {
    const copy = copies.at(-1);
    if (copy) copy.text = String(text ?? "").slice(0, ${CLIPBOARD_TEXT_LIMIT});
  };
  // Capturing at window runs before page handlers can stop the event, and
  // before cut removes the selection.
  const snapshot = (event) => {
    if (keying && event.isTrusted) record(selection());
  };
  // Bubbling back to window picks up text a page handler set instead.
  const replace = (event) => {
    if (keying && event.isTrusted && event.defaultPrevented) record(event.clipboardData?.getData("text/plain"));
  };
  for (const type of ["copy", "cut"]) {
    addEventListener(type, snapshot, true);
    addEventListener(type, replace);
  }
  // A key's copy was keyed between its dispatch and acknowledgement; older copies are stale.
  globalThis.takeCopy = (since, until) => {
    while (copies.length > 0 && copies[0].at < since) copies.shift();
    return copies[0] && copies[0].at <= until ? copies.shift().text : "";
  };
})();`;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const assetSigner = yield* AssetSigner.AssetSigner;
  const serviceClock = yield* Clock.Clock;
  const host = { platform: yield* HostProcess.Platform, arch: yield* HostProcess.Architecture };
  const manager = yield* PreviewManager.PreviewManager;
  const hosting = yield* PreviewHosting.PreviewHosting;
  const { serverEpoch } = yield* manager.list({});
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const previewBrowser = yield* PreviewBrowser.PreviewBrowser;
  const desktopChannel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
  const agentTurns = yield* (yield* PreviewAgentActivity.PreviewAgentActivity).changes;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const runSyncExit = Effect.runSyncExitWith(yield* Effect.context<never>());
  const launchFork = Effect.runForkWith(yield* Effect.context<never>());
  const rememberHostedRun = (
    tab: ServerTab,
    destination: { readonly url: string; readonly runId?: string | undefined },
  ) => {
    tab.hostedRunId = destination.runId ?? null;
    // A listener owns every path; a redirect cannot transfer its prepared run to another origin.
    tab.hostedRunOrigin = new URL(destination.url).origin;
  };
  const hostedRunChanged = (
    tab: ServerTab,
    destination: {
      readonly url: string;
      readonly runId?: string | undefined;
      readonly restarted?: boolean | undefined;
    },
  ) =>
    tab.hostedRunOrigin !== new URL(destination.url).origin ||
    tab.hostedRunId === undefined ||
    destination.runId === undefined
      ? destination.restarted === true
      : destination.runId !== tab.hostedRunId;
  const backgroundFibers = new Set<Fiber.Fiber<unknown, unknown>>();
  const pendingReports = new Set<Promise<void>>();
  const runFork = <A, E>(effect: Effect.Effect<A, E>) => {
    const fiber = launchFork(effect);
    backgroundFibers.add(fiber);
    fiber.addObserver(() => backgroundFibers.delete(fiber));
    return fiber;
  };
  const launchServices = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  // sudo resets the environment, so the command has to name this server's home.
  const setupCommand = yield* resolveRootCliCommand(PreviewBrowserHost.SETUP_SUBCOMMAND, [
    "--base-dir",
    config.baseDir,
  ]);
  const agentScope = yield* AgentScope;
  const launchersDir = NodePath.join(config.stateDir, "server-browser", "launchers");

  const tabs = new Map<string, ServerTab>();
  const pendingTabs = new Map<
    string,
    { readonly agentId: string | null; promise?: Promise<ServerTab> }
  >();
  const pendingNativeTabs = new Set<string>();
  const pendingTabOwners = new Map<string, string>();
  /** Verified origins belong to the preview session, which can outlive its attachment. */
  const sessionHostedOrigins = new Map<string, Map<string, string>>();
  const hostingActivityUrl = Effect.fn("ServerBrowser.hostingActivityUrl")(function* (
    threadId: string,
    url: string,
    origins?: ReadonlyMap<string, string>,
  ) {
    const target = URL.parse(url);
    if (target === null) return url;
    const localOrigin = origins?.get(target.origin);
    if (localOrigin !== undefined) {
      const local = new URL(localOrigin);
      target.protocol = local.protocol;
      target.host = local.host;
      return target.href;
    }
    if (!isPrivateNetworkHost(target.hostname) || isLocalLoopbackHost(target.hostname)) return url;
    const leases = yield* hosting.list(threadId);
    const port = target.port || (target.protocol === "https:" ? "443" : "80");
    const listeners = new Set(
      leases.flatMap((lease) => {
        const local = new URL(lease.url);
        return (local.port || (local.protocol === "https:" ? "443" : "80")) === port
          ? [local.origin]
          : [];
      }),
    );
    if (listeners.size !== 1) return url;
    const local = new URL([...listeners][0]!);
    target.protocol = local.protocol;
    target.host = local.host;
    return target.href;
  });
  const syncHostedPageActivity = Effect.fn("ServerBrowser.syncHostedPageActivity")(function* (
    tab: ServerTab,
    url = tab.page.url(),
  ) {
    const active = !tab.closing && tab.pageActivity > 0;
    yield* hosting.setActivity({
      activityId: tab.hostingActivityId,
      threadId: tab.threadId,
      url: active ? yield* hostingActivityUrl(tab.threadId, url, tab.hostedOrigins) : url,
      active,
    });
  });
  const acquireHostingDestination = async (
    target: { readonly threadId: string; readonly hostedOrigins?: ReadonlyMap<string, string> },
    url: string,
  ) => {
    const activityId = `server-browser-destination:${NodeCrypto.randomUUID()}`;
    const localUrl = await runPromise(
      hostingActivityUrl(target.threadId, url, target.hostedOrigins),
    );
    await runPromise(
      hosting.setActivity({ activityId, threadId: target.threadId, url: localUrl, active: true }),
    );
    return () =>
      runPromise(
        hosting.setActivity({
          activityId,
          threadId: target.threadId,
          url: localUrl,
          active: false,
        }),
      );
  };
  const withHostedDestination = async <A>(
    target: { readonly threadId: string; readonly hostedOrigins?: ReadonlyMap<string, string> },
    url: string,
    operation: () => Promise<A>,
  ): Promise<A> => {
    const release = await acquireHostingDestination(target, url);
    try {
      return await operation();
    } finally {
      await release();
    }
  };
  const syncNativeHostingPresentation = Effect.fn("ServerBrowser.syncNativeHostingPresentation")(
    function* (key: DesktopBrowserChannel.DesktopTabKey) {
      const { sessions } = yield* manager.list({ threadId: ThreadId.make(key.threadId) });
      const snapshot = sessions.find((session) => session.tabId === key.tabId);
      if (snapshot && (snapshot.desktopHostId ?? "local") !== (key.desktopHostId ?? "local"))
        return;
      const active =
        snapshot !== undefined &&
        snapshot.navStatus._tag !== "Idle" &&
        (desktopChannel.isPresented(key) || desktopChannel.isRendering(key));
      const url = snapshot?.navStatus._tag !== "Idle" ? snapshot?.navStatus.url : undefined;
      yield* hosting.setActivity({
        activityId: `server-browser-presentation:${tabKey(key.threadId, key.tabId)}`,
        threadId: key.threadId,
        url:
          active && url !== undefined
            ? yield* hostingActivityUrl(
                key.threadId,
                url,
                sessionHostedOrigins.get(tabKey(key.threadId, key.tabId)),
              )
            : "about:blank",
        active,
      });
    },
  );
  /** Explicit environment selection uses built-ins; physical server storage alone does not. */
  const environmentProfileSessions = new Set<string>();
  /** Sessions closed while their tab was still opening; the open discards its page. */
  const closedPendingTabs = new Set<string>();
  /** Popup pages waiting for the tab their `opened` event creates. */
  const adoptedPages = new Map<
    string,
    {
      readonly page: Page;
      readonly openerTabId: string;
      readonly hostedOrigins: Map<string, string>;
    }
  >();
  const nativePopups = new Map<
    string,
    {
      readonly source: DesktopBrowserChannel.DesktopTabKey;
      readonly popupId: string;
      hostedOrigins: Map<string, string>;
      snapshot: PreviewSessionSnapshot | null;
      closed: boolean;
      closeRequested: boolean;
      bound: boolean;
    }
  >();
  const popupKey = (source: DesktopBrowserChannel.DesktopTabKey, popupId: string) =>
    JSON.stringify([source.desktopHostId ?? "local", source.threadId, source.tabId, popupId]);
  const nativePopupForTab = (threadId: string, tabId: string) =>
    [...nativePopups.values()].find(
      (popup) => popup.snapshot?.threadId === threadId && popup.snapshot.tabId === tabId,
    );
  const confirmNativePopupClosed = Effect.fn("ServerBrowser.confirmNativePopupClosed")(function* (
    id: string,
    popup = nativePopups.get(id),
  ) {
    if (!popup || nativePopups.get(id) !== popup) return;
    popup.closed = true;
    nativePopups.delete(id);
    if (popup.snapshot)
      yield* manager
        .nativeClosedConfirmed({
          threadId: ThreadId.make(popup.snapshot.threadId),
          tabId: popup.snapshot.tabId,
        })
        .pipe(Effect.ignore);
  });
  const nativeRoots = new Map<
    string,
    {
      readonly key: DesktopBrowserChannel.DesktopTabKey;
      readonly automationOwner: string;
      rootId: string | null;
      closed: boolean;
      closeRequested: boolean;
      published: boolean;
    }
  >();
  const confirmNativeRootClosed = Effect.fn("ServerBrowser.confirmNativeRootClosed")(function* (
    event: DesktopBrowserChannel.DesktopTabKey & { readonly rootId: string },
    expected = nativeRoots.get(tabKey(event.threadId, event.tabId)),
  ) {
    const key = tabKey(event.threadId, event.tabId);
    const root = nativeRoots.get(key);
    if (
      !root ||
      root !== expected ||
      (root.key.desktopHostId ?? "local") !== (event.desktopHostId ?? "local") ||
      (root.rootId !== null && root.rootId !== event.rootId)
    )
      return;
    root.rootId = event.rootId;
    root.closed = true;
    if (!root.published) {
      if (root.closeRequested) nativeRoots.delete(key);
      return;
    }
    nativeRoots.delete(key);
    yield* manager.nativeClosedConfirmed({
      threadId: ThreadId.make(event.threadId),
      tabId: event.tabId,
    });
  });
  /** Sessions the manager closed, so their tabs end for good. Pruned once dropped. */
  const closedSessions = new Set<string>();
  let hostConnectionId: string | null = null;
  let viewerResizeOrder = 0;

  const contexts = new ServerBrowserContexts({
    profilesDir: NodePath.join(config.stateDir, "server-browser", "profiles"),
    idleBrowserMs: 5 * 60_000,
    executable: () => runPromise(previewBrowser.executable),
    // An agent scope keeps Chrome out of the server's memory protection and OOM score.
    launcher: async (executable) => {
      const launch = await runPromise(
        agentScope.wrap({ command: executable, args: [], name: "preview-browser" }),
      );
      if (launch.command === executable) return undefined;
      await NodeFSP.mkdir(launchersDir, { recursive: true });
      const launcher = NodePath.join(launchersDir, NodeCrypto.randomUUID());
      await NodeFSP.writeFile(launcher, agentScopeLauncherScript(launch), { mode: 0o700 });
      return { path: launcher, release: () => NodeFSP.rm(launcher, { force: true }) };
    },
    // Playwright's launch error drops Chrome's own output; its sandbox note survives.
    diagnose: (executable, cause) =>
      Effect.runPromiseWith(launchServices)(
        PreviewBrowserHost.diagnoseLaunchFailure({
          executable,
          setupCommand,
          output: /sandboxing failed/i.test(String(cause))
            ? PreviewBrowserHost.NO_SANDBOX_SIGNATURE
            : "",
        }),
      ),
    onContextClose: (context) => {
      for (const tab of tabs.values()) {
        if (tab.page.context() === context) dropTab(tab, false);
      }
    },
  });

  // Playwright cannot reload a crashed page, so a fresh page takes over its tab.
  const reopenCrashedTab = async (tab: ServerTab) => {
    if (tab.desktop) return dropTab(tab, false);
    const key = tabKey(tab.threadId, tab.tabId);
    if (tabs.get(key) !== tab) return;
    const crash = {
      url: ServerBrowserPage.withoutDataPayload(tab.page.url()).slice(0, 2048),
      code: -2,
      description: "Page crashed",
    };
    tab.crash = crash;
    const reopening = (async () => {
      // The session must name the crash before a new page reads it, or it would load the URL again.
      await runPromise(
        manager
          .reportStatus({
            threadId: tab.threadId,
            tabId: tab.tabId,
            serverControlled: true,
            navStatus: { _tag: "LoadFailed", title: "", ...crash },
            canGoBack: false,
            canGoForward: false,
          })
          .pipe(Effect.ignore),
      );
      dropTab(tab, false);
      // A context that is still closing would take the new page down with it.
      if (tab.isolatedContext) await tab.page.context().close().catch(constVoid);
      const { sessions } = await runPromise(manager.list({ threadId: tab.threadId }));
      const snapshot = sessions.find(
        (session) => session.tabId === tab.tabId && session.runtime === "server",
      );
      if (!snapshot) {
        throw new ServerBrowserTabNotFoundError({ threadId: tab.threadId, tabId: tab.tabId });
      }
      return createTab(snapshot, false, tab.page.url());
    })().finally(() => {
      pendingTabs.delete(key);
      closedPendingTabs.delete(key);
    });
    // Reserved before the dead page leaves, so a lookup in between waits for its replacement.
    pendingTabs.set(key, { agentId: tab.control.agentId, promise: reopening });
    await reopening.catch(constVoid);
  };

  const dialogStatus = (tab: ServerTab) =>
    tab.dialog
      ? {
          type: tab.dialog.type(),
          message: tab.dialog.message().slice(0, 4000),
          defaultValue: tab.dialog.defaultValue().slice(0, 4000),
        }
      : null;

  const updateFileChooserInterception = (tab: ServerTab) => {
    // Only agents and streamed controllers can answer intercepted uploads; native desktop views use the OS picker.
    const intercept = !tab.desktop || tab.agentOperating || tab.control.controller !== null;
    if (intercept === tab.fileChooserIntercepted) return;
    tab.fileChooserIntercepted = intercept;
    if (intercept) tab.page.on("filechooser", tab.onFileChooser);
    else tab.page.off("filechooser", tab.onFileChooser);
  };

  const broadcastControl = (tab: ServerTab) => {
    updateFileChooserInterception(tab);
    for (const viewer of tab.viewers)
      viewer.push({
        _tag: "control",
        canOperate: viewer.canOperate,
        controller:
          tab.control.controller === viewer.id
            ? tab.control.controllerReady
              ? "you"
              : "taking-control"
            : tab.control.controller !== null
              ? "another-viewer"
              : tab.control.agentId !== null
                ? "agent"
                : "unclaimed",
        generation: tab.control.generation,
        dialog: dialogStatus(tab),
      });
  };

  const resolveDialog = async (tab: ServerTab, input: PreviewAutomationDialogInput) => {
    const dialog = tab.dialog;
    if (!dialog) throw new Error("No dialog is pending.");
    if (input.accept) await dialog.accept(input.promptText);
    else await dialog.dismiss();
    if (tab.dialog === dialog) tab.dialog = null;
    ServerBrowserPage.invalidateRefs(tab.page);
    broadcastControl(tab);
  };

  const trackReport = (reporting: Promise<void>) => {
    pendingReports.add(reporting);
    void reporting.then(
      () => pendingReports.delete(reporting),
      () => pendingReports.delete(reporting),
    );
    return reporting;
  };

  const report = (tab: ServerTab, navStatus: PreviewNavStatus) => {
    tab.latestNavigationStatus = navStatus;
    const sequence = ++tab.navigationSequence;
    const reporting = tab.cdp
      .send("Page.getNavigationHistory")
      .catch(() => null)
      .then((history) => {
        if (tab.crash || tab.closing || tab.navigationSequence !== sequence) return;
        const index = history?.currentIndex ?? 0;
        const count = history?.entries.length ?? 0;
        return runPromise(
          manager
            .reportStatus({
              threadId: tab.threadId,
              tabId: tab.tabId,
              serverControlled: true,
              navStatus,
              canGoBack: index > 0,
              canGoForward: index < count - 1,
            })
            .pipe(Effect.ignore),
        );
      });
    return trackReport(reporting);
  };

  const reportLoaded = (tab: ServerTab, sampleCurrentNavigation = false) =>
    trackReport(
      (async () => {
        const sequence = tab.navigationSequence;
        const url = tab.page.url();
        // Chromium's error page loads after `requestfailed` and must not clear LoadFailed.
        if (url === "about:blank" || url.startsWith("chrome-error://")) return;
        // A navigation that starts and fails during the title read leaves the URL unchanged.
        const generation = tab.navigationGeneration;
        if (
          sampleCurrentNavigation &&
          (await tab.page.evaluate("document.readyState").catch(() => null)) !== "complete"
        )
          return;
        const title = (await tab.page.title().catch(() => "")).slice(0, 512);
        if (
          tab.closing ||
          tab.loading ||
          tab.navigationFailed ||
          tab.navigationSequence !== sequence ||
          tab.navigationGeneration !== generation ||
          tab.page.url() !== url
        )
          return;
        await report(tab, {
          _tag: "Success",
          url: ServerBrowserPage.withoutDataPayload(url).slice(0, 2048),
          title,
        });
      })(),
    );

  const reportLiveTabs = () => {
    const connectionId = hostConnectionId;
    if (connectionId === null) return;
    runFork(
      environment.getEnvironmentId.pipe(
        Effect.flatMap((environmentId) =>
          broker.focusHost({
            clientId: SERVER_HOST_CLIENT_ID,
            environmentId,
            connectionId,
            focused: true,
            liveTabs: [...tabs.values()].map((tab) => ({
              threadId: tab.threadId,
              tabId: tab.tabId,
              visible: tab.nativePresented || tab.viewers.size > 0,
            })),
          }),
        ),
      ),
    );
  };

  // Desktop pages have no Playwright viewport; an isolated world keeps page script
  // from overriding the CSS size. A failed read answers null and keeps the last usable size.
  const readDesktopViewport = async (tab: ServerTab) => {
    const readSize = async () => {
      const { frameTree } = await tab.cdp.send("Page.getFrameTree");
      const { executionContextId } = await tab.cdp.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "t3-preview-viewport",
      });
      const { result } = await tab.cdp.send("Runtime.evaluate", {
        expression: "({ width: innerWidth, height: innerHeight })",
        contextId: executionContextId,
        returnByValue: true,
      });
      return asRecord(result.value);
    };
    const size = await runPromise(
      // A navigation can destroy the isolated world mid-read.
      Effect.promise(() => readSize().catch(() => null)).pipe(
        Effect.timeoutOption(DESKTOP_VIEWPORT_READ_TIMEOUT),
        Effect.map(Option.getOrNull),
      ),
    );
    const width = size?.width;
    const height = size?.height;
    if (typeof width === "number" && width > 0 && typeof height === "number" && height > 0)
      return (tab.desktopViewport = { width, height });
    tab.desktopViewportStale = true;
    return null;
  };

  // Reads run one at a time, and callers that arrive during a read share the next one.
  const measureDesktopViewport = (tab: ServerTab) =>
    (tab.desktopViewportNext ??= tab.desktopViewportRead.then(() => {
      tab.desktopViewportNext = null;
      tab.desktopViewportStale = false;
      return (tab.desktopViewportRead = readDesktopViewport(tab));
    }));

  const layoutSize = async (tab: ServerTab) => {
    // A dialog blocks page script; its close measures again.
    if (tab.desktop) {
      return tab.dialog
        ? tab.desktopViewport
        : ((await measureDesktopViewport(tab)) ?? tab.desktopViewport);
    }
    const size = tab.page.viewportSize();
    if (!size) return size;
    return {
      width: Math.max(1, Math.round(size.width / tab.zoomFactor)),
      height: Math.max(1, Math.round(size.height / tab.zoomFactor)),
    };
  };

  // Page resizes and loads mark the size stale; only then does status read the page. One
  // during the read it waits for can leave that answer old, so it reads once more.
  const desktopStatusViewport = async (tab: ServerTab) => {
    const changes = tab.desktopViewportChanges;
    await (tab.desktopViewportStale || tab.dialog ? layoutSize(tab) : tab.desktopViewportRead);
    if (tab.desktopViewportChanges !== changes) await layoutSize(tab);
    return tab.desktopViewport;
  };

  /**
   * Hidden roots use native zoom. Headless pages lay out in fewer CSS pixels
   * and draw each one larger; embedded desktop guests own their zoom.
   */
  const applyZoom = async (tab: ServerTab) => {
    if (tab.backingPage === "desktop-root") {
      await withNativeSurface(
        tab,
        new AbortController().signal,
        () => 2500,
        async () => {},
        tab.setting,
        {
          zoomFactor: tab.zoomFactor,
        },
      );
      return;
    }
    if (tab.desktop) return;
    const size = tab.page.viewportSize();
    if (!size) return;
    if (tab.zoomFactor === 1) {
      await tab.page.setViewportSize(size);
      return;
    }
    const layout = (await layoutSize(tab))!;
    await tab.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: layout.width,
      height: layout.height,
      deviceScaleFactor: RENDER_SCALE * tab.zoomFactor,
      mobile: false,
    });
  };

  const broadcastViewport = async (tab: ServerTab) => {
    const size = await layoutSize(tab);
    if (!size || tab.closing) return;
    for (const viewer of tab.viewers) viewer.push({ _tag: "viewport", ...size });
  };

  const applySetting = async (tab: ServerTab, setting: PreviewViewportSetting) => {
    tab.setting = setting;
    // The desktop lays its webview out at the published setting itself.
    if (tab.desktop && tab.backingPage !== "desktop-root") return;
    const size =
      fixedViewportSize(setting) ??
      [...tab.viewers]
        .map((viewer) => viewer.requestedSize)
        .filter((requested) => requested !== null)
        .sort((left, right) => right.order - left.order)[0] ??
      UNATTACHED_FILL_VIEWPORT;
    if (tab.backingPage === "desktop-root") {
      await withNativeSurface(
        tab,
        new AbortController().signal,
        () => 2500,
        async () => {},
        setting,
        {
          viewportSize: { width: size.width, height: size.height },
        },
      );
    } else {
      await tab.page.setViewportSize({ width: size.width, height: size.height });
      await applyZoom(tab);
    }
    await broadcastViewport(tab);
  };

  /** Applies appearance and zoom to pages whose rendering the server owns. */
  const applyRendering = async (tab: ServerTab, snapshot: PreviewSessionSnapshot) => {
    const colorScheme = snapshot.colorScheme ?? "system";
    if (colorScheme !== tab.colorScheme) {
      tab.colorScheme = colorScheme;
      await tab.page.emulateMedia({ colorScheme: colorScheme === "system" ? null : colorScheme });
    }
    const zoomFactor = snapshot.zoomFactor ?? 1;
    if (zoomFactor !== tab.zoomFactor && (!tab.desktop || tab.backingPage === "desktop-root")) {
      tab.zoomFactor = zoomFactor;
      await applyZoom(tab);
      await broadcastViewport(tab);
    }
  };

  const sessionOpen = (tab: ServerTab) => !closedSessions.has(tabKey(tab.threadId, tab.tabId));

  // Closing the session makes the desktop destroy its webview, which drops an unload still in
  // progress, and `runBeforeUnload` resolves before it runs. So wait for the page's `pagehide`.
  const unloadDesktopPage = async (page: Page) => {
    const unloaded = Promise.withResolvers<void>();
    const timeout = setTimeout(unloaded.resolve, PAGE_CLOSE_GRACE_MS);
    const binding = `__t3PreviewUnloaded${NodeCrypto.randomUUID().replaceAll("-", "")}`;
    void (async () => {
      await page.exposeFunction(binding, unloaded.resolve);
      await page.evaluate((name) => {
        const target = globalThis as unknown as {
          addEventListener: (type: string, listener: () => void) => void;
        };
        target.addEventListener("pagehide", () =>
          Reflect.apply(Reflect.get(target, name), target, []),
        );
      }, binding);
      await page.close({ runBeforeUnload: true });
    })().catch(unloaded.resolve);
    await unloaded.promise;
    clearTimeout(timeout);
  };

  const dropTab = (tab: ServerTab, closeSession: boolean) => {
    const key = tabKey(tab.threadId, tab.tabId);
    if (tabs.get(key) !== tab) return;
    tabs.delete(key);
    if (closeSession || !sessionOpen(tab)) {
      sessionHostedOrigins.delete(key);
      environmentProfileSessions.delete(key);
    }
    tab.closing = true;
    tab.viewerAttached?.resolve();
    runFork(syncHostedPageActivity(tab).pipe(Effect.ignore));
    tab.viewerNavigation?.abort(new BrowserControlInterrupted());
    clearAbortedNavigation(tab);
    // A lost page can be recreated unless its canonical session was explicitly closed.
    const end = !closeSession && sessionOpen(tab) ? "reconnect" : "gone";
    for (const viewer of tab.viewers) viewer.push({ _tag: end });
    void tab.control.close().catch(constVoid);
    if (tab.desktop) void tab.desktop.close().catch(constVoid);
    else {
      const page = tab.page;
      // `runBeforeUnload` returns before the page closes, so closing an isolated context
      // must wait for it. A pending dialog would block `beforeunload` from running at all.
      const closed = page.isClosed()
        ? Promise.resolve()
        : new Promise<void>((resolve) => page.once("close", () => resolve()));
      // A renderer that never finishes unloading would outlive its tab, so force it closed.
      const forceClose = setTimeout(() => void page.close().catch(constVoid), PAGE_CLOSE_GRACE_MS);
      void closed.then(() => clearTimeout(forceClose));
      void page
        // A crashed page never answers `beforeunload`, so that close would not finish.
        .close({ runBeforeUnload: tab.dialog === null && tab.crash === undefined })
        .catch(() => page.close())
        .catch(constVoid);
      if (tab.isolatedContext) void closed.then(() => page.context().close()).catch(constVoid);
    }
    void tab.recording?.encoder.close().catch(constVoid);
    void tab.recording?.releaseSurface();
    void NodeFSP.rm(downloadDir(tab), { recursive: true, force: true }).catch(constVoid);
    reportLiveTabs();
    if (closeSession) {
      runFork(manager.close({ threadId: tab.threadId, tabId: tab.tabId }).pipe(Effect.ignore));
    }
  };

  const updateHeadlessLifecycle = (tab: ServerTab) => {
    const updated = tab.lifecycle.then(async () => {
      if (tab.desktop || tab.closing) return;
      const frozen = tab.pageActivity === 0;
      if (tab.frozen === frozen) return;
      await tab.cdp.send("Page.setWebLifecycleState", { state: frozen ? "frozen" : "active" });
      tab.frozen = frozen;
    });
    tab.lifecycle = updated.catch(constVoid);
    return updated;
  };

  const acquirePageActivity = async (tab: ServerTab) => {
    tab.pageActivity += 1;
    tab.usedAt = Date.now();
    try {
      await runPromise(syncHostedPageActivity(tab));
      await updateHeadlessLifecycle(tab);
    } catch (cause) {
      tab.pageActivity -= 1;
      await runPromise(syncHostedPageActivity(tab));
      throw cause;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      tab.pageActivity -= 1;
      tab.usedAt = Date.now();
      await runPromise(syncHostedPageActivity(tab));
      await updateHeadlessLifecycle(tab);
    };
  };

  /** Wait only for the page owner chosen before the session was published. */
  const desktopRenders = (snapshot: PreviewSessionSnapshot) =>
    !snapshot.headless &&
    (snapshot.backingPage === "desktop" ||
      snapshot.backingPage === "desktop-popup" ||
      snapshot.backingPage === "desktop-root")
      ? runPromise(
          Effect.gen(function* () {
            const key = {
              threadId: snapshot.threadId,
              tabId: snapshot.tabId,
              ...(snapshot.desktopHostId === undefined
                ? {}
                : { desktopHostId: snapshot.desktopHostId }),
            };
            // A reloaded desktop mounts a thread's tabs again only once an event for it arrives,
            // and a renderer still reloading misses events, so repeat it until the wait ends.
            if (!(yield* desktopChannel.isAttached(key))) {
              yield* manager
                .announce({ threadId: ThreadId.make(key.threadId), tabId: key.tabId })
                .pipe(Effect.ignore, Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped);
            }
            return yield* desktopChannel.awaitAttached(key, DESKTOP_ATTACH_TIMEOUT);
          }).pipe(Effect.scoped),
        )
      : Promise.resolve(false);

  const connectDesktop = async (snapshot: PreviewSessionSnapshot) => {
    const scope = await runPromise(Scope.make());
    try {
      const endpoint = await runPromise(
        desktopChannel
          .endpoint({
            threadId: snapshot.threadId,
            tabId: snapshot.tabId,
            ...(snapshot.desktopHostId === undefined
              ? {}
              : { desktopHostId: snapshot.desktopHostId }),
          })
          .pipe(Scope.provide(scope)),
      );
      const connected = await contexts.connectDesktopPage(endpoint);
      return {
        page: connected.page,
        close: async () => {
          await connected.browser.close().catch(constVoid);
          await runPromise(Scope.close(scope, Exit.void));
        },
      };
    } catch (cause) {
      await runPromise(Scope.close(scope, Exit.void));
      throw cause;
    }
  };

  const createTab = async (
    snapshot: PreviewSessionSnapshot,
    restoreNavigation = false,
    crashedUrl?: string,
  ): Promise<ServerTab> => {
    const opened: Array<() => Promise<void>> = [];
    try {
      return await setUpTab(snapshot, opened, restoreNavigation, crashedUrl);
    } catch (cause) {
      // An unpublished tab is in no list, so nothing else would ever close it.
      for (const close of opened.reverse()) await close().catch(constVoid);
      throw cause;
    }
  };

  const setUpTab = async (
    snapshot: PreviewSessionSnapshot,
    opened: Array<() => Promise<void>>,
    restoreNavigation: boolean,
    crashedUrl: string | undefined,
  ): Promise<ServerTab> => {
    const adopted = adoptedPages.get(tabKey(snapshot.threadId, snapshot.tabId));
    adoptedPages.delete(tabKey(snapshot.threadId, snapshot.tabId));
    const nativePopup = nativePopupForTab(snapshot.threadId, snapshot.tabId);
    const hostedOrigins =
      sessionHostedOrigins.get(tabKey(snapshot.threadId, snapshot.tabId)) ??
      adopted?.hostedOrigins ??
      nativePopup?.hostedOrigins ??
      new Map(
        await runPromise(
          manager.getHostedOrigins({ threadId: snapshot.threadId, tabId: snapshot.tabId }),
        ),
      );
    const nativeRoot =
      snapshot.backingPage === "desktop-root"
        ? nativeRoots.get(tabKey(snapshot.threadId, snapshot.tabId))
        : undefined;
    if (snapshot.backingPage === "desktop-root") {
      if (!nativeRoot || nativeRoot.closed || nativeRoot.rootId !== snapshot.desktopRootId)
        throw new Error("The native browser root is unavailable.");
    }
    if (snapshot.backingPage === "desktop-popup") {
      if (!nativePopup || nativePopup.closed || nativePopup.popupId !== snapshot.desktopPopupId)
        throw new Error("The native popup binding is unavailable.");
      // A bound child survives channel reconnects and re-announces its server
      // key. Binding is only needed for the initial window announcement.
      if (!nativePopup.bound)
        await runPromise(
          desktopChannel.bindPopup(
            {
              threadId: snapshot.threadId,
              tabId: snapshot.tabId,
              desktopHostId: snapshot.desktopHostId,
            },
            { popupId: nativePopup.popupId, openerTabId: nativePopup.source.tabId },
          ),
        );
    }
    const desktop =
      adopted === undefined && (await desktopRenders(snapshot))
        ? await connectDesktop(snapshot)
        : null;
    if (desktop) opened.push(desktop.close);
    // Attaching over CDP emulates a light scheme; a tab on System follows the desktop's.
    if (desktop) await desktop.page.emulateMedia({ colorScheme: null });
    if (nativePopup && desktop) nativePopup.bound = true;
    if (
      adopted === undefined &&
      (snapshot.backingPage === "desktop" ||
        snapshot.backingPage === "desktop-popup" ||
        snapshot.backingPage === "desktop-root") &&
      desktop === null
    ) {
      throw new ServerBrowserPage.ServerBrowserOperationError({
        tag: "PreviewAutomationRemoteUnavailableError",
        message:
          "The selected desktop browser did not attach. Keep that desktop connected and retry; the requested profile was not opened in another browser.",
      });
    }
    // Otherwise a desktop that attaches late shows its own page, and the agent drives another.
    if (!desktop) {
      await runPromise(
        manager
          .markHeadless({ threadId: ThreadId.make(snapshot.threadId), tabId: snapshot.tabId })
          .pipe(Effect.ignore),
      );
    }
    const isolatedContext =
      adopted === undefined &&
      desktop === null &&
      ((snapshot.automationOwner !== undefined && snapshot.profileId === undefined) ||
        snapshot.profileId === INCOGNITO_BROWSER_PROFILE_ID);
    const context =
      adopted?.page.context() ??
      desktop?.page.context() ??
      (await contexts.contextFor(
        snapshot.profileId ?? "default",
        isolatedContext ? tabKey(snapshot.threadId, snapshot.tabId) : undefined,
      ));
    if (isolatedContext) opened.push(() => context.close());
    if (adopted?.page.isClosed()) throw new Error("The popup closed before it opened.");
    if (!desktop) await prepareContext(context);
    const page = adopted?.page ?? desktop?.page ?? (await context.newPage());
    if (!desktop) opened.push(() => page.close());
    const cdp = await context.newCDPSession(page);
    const pdfNavigation = await createPdfDocumentNavigation(cdp);
    // The desktop's page is already a normal browser. A popup's first request
    // went out before it became a tab; everything after presents as Chrome.
    if (!desktop) await presentAsChrome(cdp, host);
    if (!desktop) await recordCopies(cdp);
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    const control = new SessionControl(snapshot.automationOwner ?? null, () => {
      tab.viewerNavigation?.abort(new BrowserControlInterrupted());
      ServerBrowserPage.invalidateRefs(page);
    });
    const openerTabId = adopted?.openerTabId ?? nativePopup?.source.tabId;
    let pendingFileChooserOffer = Promise.resolve();
    const tab: ServerTab = {
      threadId: ThreadId.make(snapshot.threadId),
      tabId: snapshot.tabId,
      page,
      cdp,
      frameSessions: new Map(),
      copyReads: Promise.resolve(),
      copyKeyedUntil: 0,
      createdAt: Date.now(),
      usedAt: Date.now(),
      viewers: new Set(),
      viewerAttached: null,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      control,
      agentOperating: false,
      threadLinkViewer: null,
      pageActivity: 0,
      hostingActivityId: `server-browser-page:${tabKey(snapshot.threadId, snapshot.tabId)}:${NodeCrypto.randomUUID()}`,
      frozen: false,
      lifecycle: Promise.resolve(),
      fileChooserIntercepted: false,
      onFileChooser: (chooser) => {
        pendingFileChooserOffer = pendingFileChooserOffer
          .then(() => offerFileChooser(tab, chooser))
          .catch(constVoid);
      },
      isolatedContext,
      desktop: desktop === null ? null : { close: desktop.close },
      profileId: snapshot.profileId,
      desktopHostId: snapshot.desktopHostId,
      backingPage: snapshot.backingPage,
      nativePresented: false,
      revealRequested: snapshot.reveal === true,
      openerTabId,
      downloads: [],
      hostedOrigins,
      hostedRunId: undefined,
      hostedRunOrigin: undefined,
      viewerNavigation: null,
      fileChooser: null,
      dialog: null,
      setting: snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
      colorScheme: "system",
      zoomFactor: 1,
      desktopViewport: null,
      desktopViewportRead: Promise.resolve(null),
      desktopViewportNext: null,
      desktopViewportStale: true,
      desktopViewportChanges: 0,
      desktopResize: Promise.withResolvers<void>(),
      loading: false,
      loadError: undefined,
      // The page a crash left behind is blank; the session still names what crashed.
      crash:
        crashedUrl !== undefined && !desktop && !adopted && snapshot.navStatus._tag === "LoadFailed"
          ? {
              url: snapshot.navStatus.url,
              code: snapshot.navStatus.code,
              description: snapshot.navStatus.description,
            }
          : undefined,
      crashedUrl,
      navigationSequence: 0,
      latestNavigationStatus: snapshot.navStatus,
      navigationFailed: snapshot.navStatus._tag === "LoadFailed",
      closing: false,
      recording: null,
      recordingStart: null,
      initialNavigation: null,
      pendingInitialRequestUrl: null,
      navigationReady: Promise.resolve(),
      navigationGeneration: 0,
      stoppedGeneration: null,
      abortedNavigation: null,
      captureLock: Promise.resolve(),
      capturing: 0,
    };
    const threadNavigation = await installThreadLinkNavigation(
      page,
      cdp,
      desktop !== null,
      (href) => {
        if (tab.closing || tab.agentOperating) return false;
        if (tab.threadLinkViewer) tab.threadLinkViewer.push({ _tag: "threadLink", href });
        else if (desktop && tab.nativePresented) runFork(desktopChannel.openThreadLink(tab, href));
        else return false;
        return true;
      },
      (popup) => {
        blockedThreadPopups.add(popup);
      },
      pdfNavigation ? [pdfNavigation] : [],
    );
    if (!desktop) {
      await page.setViewportSize(fixedViewportSize(tab.setting) ?? UNATTACHED_FILL_VIEWPORT);
    }
    await applyRendering(tab, snapshot);
    if (desktop) {
      // The desktop resizes and zooms its webview itself; viewers map input with the new size.
      const remeasure = () => {
        tab.desktopViewportStale = true;
        tab.desktopViewportChanges += 1;
        if (tab.viewers.size > 0) return broadcastViewport(tab).catch(constVoid);
      };
      cdp.on("Page.frameResized", () => {
        const drawn = tab.desktopResize;
        tab.desktopResize = Promise.withResolvers();
        drawn.resolve();
        return remeasure();
      });
      // A read a navigation broke has a fresh page to measure.
      cdp.on("Page.loadEventFired", remeasure);
      // Closing a dialog resizes nothing, and the host can close it without us.
      cdp.on("Page.javascriptDialogClosed", () => {
        tab.dialog = null;
        return remeasure();
      });
      await cdp.send("Page.enable");
    }
    const isMainNavigation = (request: {
      isNavigationRequest(): boolean;
      frame(): unknown;
      url(): string;
    }) =>
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame() &&
      !threadNavigation.isThreadNavigation(request.url());
    const navigationGenerations = new WeakMap<object, number>();
    page.on("request", (request) => {
      if (!isMainNavigation(request)) return;
      // Playwright can deliver the first request after Stop has already settled its navigation.
      const stoppedInitialRequest =
        request.url() === tab.pendingInitialRequestUrl &&
        tab.stoppedGeneration === tab.navigationGeneration;
      tab.pendingInitialRequestUrl = null;
      runFork(syncHostedPageActivity(tab, request.url()).pipe(Effect.ignore));
      navigationGenerations.set(request, ++tab.navigationGeneration);
      clearAbortedNavigation(tab);
      tab.loading = true;
      tab.loadError = undefined;
      tab.navigationFailed = false;
      tab.crash = undefined;
      tab.crashedUrl = undefined;
      if (stoppedInitialRequest) {
        tab.stoppedGeneration = tab.navigationGeneration;
        settleStoppedNavigation(tab, tab.navigationGeneration);
        return;
      }
      report(tab, {
        _tag: "Loading",
        url: ServerBrowserPage.withoutDataPayload(request.url()).slice(0, 2048),
        title: "",
      });
    });
    page.on("load", () => {
      tab.pendingInitialRequestUrl = null;
      tab.loading = false;
      runFork(syncHostedPageActivity(tab).pipe(Effect.ignore));
      void reportLoaded(tab);
    });
    page.on("framenavigated", (frame) => {
      const open = tab.fileChooser;
      if (open) {
        void isFileChooserCurrent(open.chooser).then((current) => {
          if (!current && tab.fileChooser?.chooser === open.chooser) closeFileChooser(tab);
        });
      }
      // Same-document navigations (SPA routes) fire no load event.
      if (frame === page.mainFrame() && !tab.loading) void reportLoaded(tab);
      if (!desktop) void recordFrameCopies(tab, frame);
    });
    // An adopted popup's frames may have loaded before the tab listened.
    if (adopted) for (const frame of page.frames()) void recordFrameCopies(tab, frame);
    page.on("requestfailed", (request) => {
      if (threadNavigation.consumeFailedNavigation(request.url())) return;
      const errorText = request.failure()?.errorText ?? "";
      pushBounded(tab.networkEntries, {
        url: ServerBrowserPage.withoutDataPayload(request.url()),
        method: request.method(),
        status: null,
        failed: true,
        errorText,
        timestamp: new Date().toISOString(),
      });
      if (!isMainNavigation(request)) return;
      // Newer navigations own status; untracked initial popup requests yield to any tracked navigation.
      const generation = navigationGenerations.get(request) ?? 0;
      if (generation !== tab.navigationGeneration) return;
      // An aborted navigation is usually a download; its `download` event settles the status.
      if (errorText.includes("ERR_ABORTED")) {
        if (tab.stoppedGeneration === generation) {
          settleStoppedNavigation(tab, generation);
          return;
        }
        const url = request.url();
        const navigationGeneration = tab.navigationGeneration;
        clearAbortedNavigation(tab);
        tab.abortedNavigation = {
          url,
          generation: navigationGeneration,
          timer: setTimeout(() => {
            if (tab.abortedNavigation?.generation !== navigationGeneration) return;
            tab.abortedNavigation = null;
            if (!tab.closing)
              void settleAbortedNavigation(tab, navigationGeneration, url, undefined).catch(
                constVoid,
              );
          }, ABORTED_NAVIGATION_DOWNLOAD_WAIT_MS),
        };
        return;
      }
      tab.loading = false;
      tab.navigationFailed = true;
      const { code, description } = ServerBrowserPage.parseNetError(errorText);
      const url = ServerBrowserPage.withoutDataPayload(request.url()).slice(0, 2048);
      tab.loadError = { url, code, description };
      report(tab, { _tag: "LoadFailed", url, title: "", code, description });
    });
    page.on("response", (response) => {
      pushBounded(tab.networkEntries, {
        url: ServerBrowserPage.withoutDataPayload(response.url()),
        method: response.request().method(),
        status: response.status(),
        failed: false,
        timestamp: new Date().toISOString(),
      });
    });
    page.on("console", (message) => {
      pushBounded(tab.consoleEntries, {
        level: message.type(),
        text: ServerBrowserPage.consoleText(message).slice(0, 2_000),
        timestamp: new Date().toISOString(),
      });
    });
    page.on("dialog", (dialog) => {
      // Closing is already decided, so an unsaved-changes guard must not keep the page open.
      if (tab.closing && dialog.type() === "beforeunload") {
        void dialog.accept().catch(constVoid);
        return;
      }
      tab.dialog = dialog;
      broadcastControl(tab);
    });
    page.on("download", (download) => void saveDownload(tab, download));
    updateFileChooserInterception(tab);
    // Popups become tabs and keep `window.opener`, so sign-in popups can report back.
    // Electron announces its actual child window separately; its one-page relay
    // cannot synthesize a Playwright popup without losing native identity.
    if (!desktop) page.on("popup", (popup) => void adoptPopup(tab, popup));
    const key = tabKey(tab.threadId, tab.tabId);
    if (
      closedPendingTabs.delete(key) ||
      nativePopup?.closed ||
      (nativeRoot !== undefined &&
        (nativeRoots.get(key) !== nativeRoot || nativeRoot.closed || nativeRoot.closeRequested))
    ) {
      await control.close().catch(constVoid);
      throw new ServerBrowserTabNotFoundError({ threadId: tab.threadId, tabId: tab.tabId });
    }
    page.on("close", () => dropTab(tab, false));
    page.on("crash", () => reopenCrashedTab(tab));
    // Sample after all asynchronous setup, in the same tick that registers
    // the tab. The presentation subscriber handles every later change.
    tab.nativePresented =
      desktop !== null &&
      desktopChannel.isPresented({
        threadId: tab.threadId,
        tabId: tab.tabId,
        desktopHostId: tab.desktopHostId,
      });
    sessionHostedOrigins.set(key, tab.hostedOrigins);
    tabs.set(key, tab);
    reportLiveTabs();
    // Native/adopted pages may have finished before their listeners were installed.
    if (adopted || desktop) void reportLoaded(tab, true);
    if (
      crashedUrl === undefined &&
      !adopted &&
      (!desktop || restoreNavigation) &&
      snapshot.navStatus._tag !== "Idle"
    ) {
      const url = snapshot.navStatus.url;
      const ready = Promise.withResolvers<void>();
      tab.navigationReady = ready.promise;
      void ready.promise.catch(constVoid);
      let prepared = false;
      tab.navigationFailed = false;
      tab.initialNavigation = withNativeSurface(
        tab,
        new AbortController().signal,
        () => NAVIGATION_TIMEOUT_MS,
        () =>
          withHostedDestination(tab, url, async () => {
            const destination = await prepareRetainedBrowserNavigation(tab, url);
            prepared = true;
            tab.loading = true;
            const initialUrl = URL.parse(destination.url);
            if (initialUrl) initialUrl.hash = "";
            tab.pendingInitialRequestUrl = initialUrl?.href ?? null;
            ready.resolve();
            await page.goto(destination.url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
            rememberHostedRun(tab, destination);
            await reportLoaded(tab, true);
          }),
      ).catch(async (cause: unknown) => {
        if (!prepared && !tab.closing) {
          tab.navigationFailed = true;
          await report(tab, {
            _tag: "LoadFailed",
            url,
            title: "",
            code: -2,
            description:
              "The saved preview could not be restored. Retry opening it when its environment is available.",
          });
          dropTab(tab, false);
        }
        const error = ServerBrowserPage.toOperationError(cause, NAVIGATION_TIMEOUT_MS);
        ready.reject(error);
        throw error;
      });
    } else if (
      snapshot.navStatus._tag === "Loading" &&
      ((!adopted && (!desktop || snapshot.backingPage === "desktop-root")) ||
        isPdfAssetUrl(snapshot.navStatus.url))
    ) {
      // Existing desktop and popup PDFs can start loading before interception attaches.
      tab.loading = true;
      const initialUrl = URL.parse(snapshot.navStatus.url);
      if (initialUrl) initialUrl.hash = "";
      tab.pendingInitialRequestUrl = initialUrl?.href ?? null;
      const options = { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS } as const;
      tab.initialNavigation = (
        (desktop || adopted) && page.url() === snapshot.navStatus.url
          ? page.reload(options)
          : page.goto(snapshot.navStatus.url, options)
      ).then(constVoid, (cause: unknown) => {
        throw ServerBrowserPage.toOperationError(cause, NAVIGATION_TIMEOUT_MS);
      });
    }
    if (tab.initialNavigation) {
      if (tab.control.agentId !== null) tab.control.track(tab.initialNavigation);
      else void tab.initialNavigation.catch(constVoid);
    } else if (!desktop) void updateHeadlessLifecycle(tab).catch(constVoid);
    return tab;
  };

  const downloadsRoot = NodePath.join(config.stateDir, "server-browser", "downloads");
  // Saved downloads are indexed in memory, so an earlier run's files can never be opened again.
  yield* Effect.tryPromise({
    try: () => NodeFSP.rm(downloadsRoot, { recursive: true, force: true }),
    catch: (cause) => new ServerBrowserDownloadsCleanupError({ cause }),
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("server preview could not clear earlier downloads", { cause }),
    ),
  );
  // Tab ids are opaque server strings; hashing keeps them out of the path.
  const downloadDir = (tab: ServerTab) =>
    NodePath.join(
      downloadsRoot,
      NodeCrypto.createHash("sha256").update(tabKey(tab.threadId, tab.tabId)).digest("hex"),
    );

  const clearAbortedNavigation = (tab: ServerTab) => {
    if (tab.abortedNavigation !== null) clearTimeout(tab.abortedNavigation.timer);
    tab.abortedNavigation = null;
  };

  const settleStoppedNavigation = (tab: ServerTab, generation: number) => {
    if (tab.navigationGeneration !== generation || !tab.loading) return;
    clearAbortedNavigation(tab);
    tab.loading = false;
    if (tab.page.url() === "about:blank") report(tab, { _tag: "Idle" });
    else void reportLoaded(tab);
  };

  const settleAbortedNavigation = async (
    tab: ServerTab,
    generation: number,
    url: string,
    offered: { readonly id: string; readonly fileName: string } | undefined,
  ) => {
    if (tab.navigationGeneration !== generation) return;
    tab.loading = false;
    if (tab.page.url() !== "about:blank") {
      return reportLoaded(tab);
    }
    return report(tab, {
      _tag: "LoadFailed",
      url: ServerBrowserPage.withoutDataPayload(url).slice(0, 2048),
      title: "",
      code: -3,
      description: "ERR_ABORTED",
      ...(offered === undefined ? {} : { download: offered }),
    });
  };

  const saveDownload = async (tab: ServerTab, download: Download) => {
    const id = NodeCrypto.randomUUID();
    const path = NodePath.join(downloadDir(tab), id);
    const navigation =
      download.url() === tab.abortedNavigation?.url ? tab.abortedNavigation.generation : null;
    if (navigation !== null) clearAbortedNavigation(tab);
    let offered: { readonly id: string; readonly fileName: string } | undefined;
    try {
      if (await download.failure()) return;
      await NodeFSP.mkdir(downloadDir(tab), { recursive: true, mode: 0o700 });
      // mkdir leaves the mode of a folder that already exists, such as one an older build made.
      await NodeFSP.chmod(downloadDir(tab), 0o700);
      await download.saveAs(path);
      // saveAs copies with the process umask; a download should stay readable by its owner only.
      await NodeFSP.chmod(path, 0o600);
      const { size } = await NodeFSP.stat(path);
      if (tab.closing || size > DOWNLOAD_MAX_BYTES) {
        await NodeFSP.rm(path, { force: true });
        return;
      }
      const saved: ServerDownload = {
        id,
        fileName: download.suggestedFilename().slice(0, 255) || "download",
        path,
        sizeBytes: size,
        url: ServerBrowserPage.withoutDataPayload(download.url()).slice(0, 2048),
        completedAt: new Date().toISOString(),
      };
      tab.downloads.push(saved);
      for (const evicted of tab.downloads.splice(0, tab.downloads.length - DOWNLOAD_LIMIT)) {
        await NodeFSP.rm(evicted.path, { force: true }).catch(constVoid);
      }
      offered = { id, fileName: saved.fileName };
      const shownInTab =
        navigation === tab.navigationGeneration && tab.page.url() === "about:blank";
      if (shownInTab) return;
      const controller = [...tab.viewers].find((viewer) => viewer.id === tab.control.controller);
      controller?.push({
        _tag: "download",
        id,
        fileName: saved.fileName,
        sizeBytes: saved.sizeBytes,
      });
    } catch (cause) {
      await NodeFSP.rm(path, { force: true }).catch(constVoid);
      runFork(Effect.logWarning("server preview download failed", { cause }));
    } finally {
      if (navigation !== null && !tab.closing) {
        await settleAbortedNavigation(tab, navigation, download.url(), offered);
      }
      // saveAs copies the artifact; cached profile contexts otherwise retain the original.
      await download.delete().catch(constVoid);
    }
  };

  const fileChooserMessage = (tab: ServerTab): ServerBrowserViewerOutput | null =>
    tab.fileChooser
      ? {
          _tag: "fileChooser",
          id: tab.fileChooser.id,
          multiple: tab.fileChooser.chooser.isMultiple(),
          accept: tab.fileChooser.accept,
        }
      : null;

  // Not isConnected: upload helpers often click an input never added to the page. The handle's
  // context is destroyed with its document, so a replaced document rejects.
  const isFileChooserCurrent = (chooser: FileChooser) =>
    chooser
      .element()
      .evaluate(
        (element) =>
          element.ownerDocument === (globalThis as unknown as { document: unknown }).document,
      )
      .catch(() => false);

  const offerFileChooser = async (tab: ServerTab, chooser: FileChooser) => {
    const previous = tab.fileChooser;
    const accept =
      (await chooser
        .element()
        .getAttribute("accept")
        .catch(() => null)) ?? "";
    if (!(await isFileChooserCurrent(chooser))) return;
    if (previous) closeFileChooser(tab);
    tab.fileChooser = {
      id: NodeCrypto.randomUUID(),
      chooser,
      accept: accept.slice(0, 1024),
      offeredTo: null,
    };
    pushFileChooser(tab);
  };

  const pushFileChooser = (tab: ServerTab) => {
    const open = tab.fileChooser;
    const controller = [...tab.viewers].find((viewer) => viewer.id === tab.control.controller);
    if (!open || !controller) return;
    if (open.offeredTo !== controller.id) {
      tab.fileChooser = { ...open, id: NodeCrypto.randomUUID(), offeredTo: controller.id };
      if (open.offeredTo !== null)
        for (const viewer of tab.viewers) viewer.push({ _tag: "fileChooserClosed", id: open.id });
    }
    const message = fileChooserMessage(tab);
    if (message) controller.push(message);
  };

  const closeFileChooser = (tab: ServerTab) => {
    const open = tab.fileChooser;
    if (!open) return;
    tab.fileChooser = null;
    for (const viewer of tab.viewers) viewer.push({ _tag: "fileChooserClosed", id: open.id });
  };

  const setChooserFiles = async (
    input: Parameters<ServerBrowser["Service"]["answerFileChooser"]>[0],
  ) => {
    const tab = tabs.get(tabKey(input.threadId, input.tabId));
    const open = tab?.fileChooser;
    if (
      !tab ||
      !open ||
      open.id !== input.chooserId ||
      open.offeredTo === null ||
      open.offeredTo !== tab.control.controller
    )
      return false;
    if (input.files.length > 0) {
      await open.chooser.setFiles(
        open.chooser.isMultiple() ? [...input.files] : input.files.slice(0, 1),
      );
    }
    if (tab.fileChooser === open) closeFileChooser(tab);
    return true;
  };
  const uploadFiles = async (
    tab: ServerTab,
    input: PreviewAutomationUploadInput,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    const relative = input.paths.find((path) => !NodePath.isAbsolute(path));
    if (relative !== undefined)
      throw new ServerBrowserPage.ServerBrowserOperationError({
        tag: "PreviewAutomationExecutionError",
        message: `Upload paths must be absolute: ${relative}`,
      });
    // A remote desktop cannot open the environment's filesystem paths. Supply
    // file bytes through Playwright, which injects the same files into its page.
    let totalBytes = 0;
    const files =
      tab.desktopHostId !== undefined && tab.desktopHostId !== "local"
        ? await Promise.all(
            input.paths.map(async (path) => {
              const handle = await NodeFSP.open(path, "r");
              try {
                const stat = await handle.stat();
                totalBytes += stat.size;
                if (!stat.isFile() || totalBytes > 64 * 1024 * 1024) {
                  throw new ServerBrowserPage.ServerBrowserOperationError({
                    tag: "PreviewAutomationExecutionError",
                    message:
                      "Remote browser uploads must be regular files totaling at most 64 MiB.",
                  });
                }
                const buffer = Buffer.alloc(stat.size);
                let offset = 0;
                while (offset < buffer.length) {
                  const { bytesRead } = await handle.read(
                    buffer,
                    offset,
                    buffer.length - offset,
                    offset,
                  );
                  if (bytesRead === 0)
                    throw new Error("An upload file changed while it was being read.");
                  offset += bytesRead;
                }
                if ((await handle.stat()).size !== stat.size)
                  throw new Error("An upload file changed while it was being read.");
                return {
                  name: NodePath.basename(path),
                  mimeType: Option.getOrElse(Mime.getType(path), () => "application/octet-stream"),
                  buffer,
                };
              } finally {
                await handle.close();
              }
            }),
          )
        : [...input.paths];
    if (await ServerBrowserPage.setInputFiles(tab.page, input, files, signal)) return undefined;
    const open = tab.fileChooser;
    if (!open)
      throw new ServerBrowserPage.ServerBrowserOperationError({
        tag: "PreviewAutomationExecutionError",
        message:
          "No file picker is open. Click the page's upload control first, or pass the file input's locator.",
      });
    if (input.paths.length > 1 && !open.chooser.isMultiple())
      throw new ServerBrowserPage.ServerBrowserOperationError({
        tag: "PreviewAutomationExecutionError",
        message: "This file picker accepts one file.",
      });
    signal?.throwIfAborted();
    if (input.paths.length > 0)
      await open.chooser.setFiles(files, {
        timeout: input.timeoutMs ?? NAVIGATION_TIMEOUT_MS,
      });
    if (tab.fileChooser === open) closeFileChooser(tab);
    return undefined;
  };

  const answerFileChooser: ServerBrowser["Service"]["answerFileChooser"] = (input) =>
    Effect.promise(() => setChooserFiles(input).catch(() => false));

  const openDownload: ServerBrowser["Service"]["openDownload"] = (input) =>
    Effect.sync(() => {
      const download = tabs
        .get(tabKey(input.threadId, input.tabId))
        ?.downloads.find((candidate) => candidate.id === input.downloadId);
      return download === undefined
        ? Option.none()
        : Option.some({ path: download.path, fileName: download.fileName });
    });

  const blockedThreadPopups = new WeakSet<Page>();
  const preparedContexts = new WeakSet<BrowserContext>();
  const prepareContext = async (context: BrowserContext) => {
    if (preparedContexts.has(context)) return;
    preparedContexts.add(context);
    await context.grantPermissions(["clipboard-write"]);
  };

  const recordCopies = async (cdp: CDPSession) => {
    // Scripts for new documents run only while this session's Page domain is on.
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: CLIPBOARD_SCRIPT,
      worldName: CLIPBOARD_WORLD,
      runImmediately: true,
    });
  };

  /** Out-of-process frames need their own copy-recording session until target closure. */
  const recordFrameCopies = async (tab: ServerTab, frame: Frame) => {
    if (frame === tab.page.mainFrame() || tab.frameSessions.has(frame)) return;

    const cdp = await tab.page
      .context()
      .newCDPSession(frame)
      .catch(() => null);
    if (!cdp) return;
    if (tab.frameSessions.has(frame) || frame.isDetached()) {
      await cdp.detach().catch(constVoid);
      return;
    }
    tab.frameSessions.set(frame, cdp);
    cdp.on("close", () => {
      if (tab.frameSessions.get(frame) !== cdp) return;
      tab.frameSessions.delete(frame);

      if (!frame.isDetached()) void recordFrameCopies(tab, frame);
    });
    await recordCopies(cdp).catch(constVoid);
  };

  const takeSessionCopies = async (cdp: CDPSession, since: number, until: number) => {
    const tree = await cdp.send("Page.getFrameTree").catch(() => null);
    if (!tree) return [];
    const frameIds = (node: typeof tree.frameTree): Array<string> => [
      node.frame.id,
      ...(node.childFrames ?? []).flatMap(frameIds),
    ];
    return Promise.all(
      frameIds(tree.frameTree).map((frameId) =>
        cdp
          .send("Page.createIsolatedWorld", { frameId, worldName: CLIPBOARD_WORLD })
          .then(({ executionContextId }) =>
            cdp.send("Runtime.evaluate", {
              contextId: executionContextId,
              expression: `globalThis.takeCopy?.(${since}, ${until})`,
              returnByValue: true,
            }),
          )
          .then(
            ({ result }) => (typeof result.value === "string" ? result.value : ""),
            () => "",
          ),
      ),
    );
  };

  const takeCopiedText = async (tab: ServerTab, since: number, until: number) => {
    const copies = await Promise.all(
      [tab.cdp, ...tab.frameSessions.values()].map((cdp) => takeSessionCopies(cdp, since, until)),
    );
    return copies.flat().find((text) => text.length > 0);
  };

  const adoptPopup = async (opener: ServerTab, popup: Page) => {
    if (opener.closing || blockedThreadPopups.has(popup)) {
      await popup.close().catch(constVoid);
      return;
    }
    const url = popup.url();
    // Opening a tab awaits setup; its opener can close before publication or attachment.
    const hostedOrigins = new Map(opener.hostedOrigins);
    const environmentProfiles = environmentProfileSessions.has(
      tabKey(opener.threadId, opener.tabId),
    );
    // Captured now: the person whose click opened the popup gets switched to it.
    const controller = [...opener.viewers].find(
      (viewer) => viewer.id === opener.control.controller,
    );
    await runPromise(
      openTab({
        threadId: opener.threadId,
        ...(/^https?:/i.test(url) ? { url } : {}),
        runtime: "server",
        ...(opener.desktop === null ? { environmentHosted: true } : {}),
        ...(opener.profileId === undefined ? {} : { profileId: opener.profileId }),
        ...(opener.desktopHostId === undefined ? {} : { desktopHostId: opener.desktopHostId }),
        ...(opener.control.agentId === null
          ? {}
          : { automationOwner: opener.control.agentId, reveal: false }),
        beforePublish: (snapshot) => {
          const key = tabKey(snapshot.threadId, snapshot.tabId);
          if (environmentProfiles) environmentProfileSessions.add(key);
          adoptedPages.set(key, {
            page: popup,
            openerTabId: opener.tabId,
            hostedOrigins,
          });
        },
      }),
    ).then(
      (tab) => {
        if (opener.control.agentId === null) controller?.push({ _tag: "popup", tabId: tab.tabId });
      },
      async () => {
        await popup.close().catch(constVoid);
      },
    );
  };

  const openNativePopup = async (
    source: DesktopBrowserChannel.DesktopTabKey & {
      readonly popupId: string;
      readonly url: string;
    },
  ) => {
    const id = popupKey(source, source.popupId);
    const existing = nativePopups.get(id);
    if (existing) {
      if (existing.closeRequested) {
        await runPromise(
          existing.snapshot
            ? manager
                .close({
                  threadId: ThreadId.make(existing.snapshot.threadId),
                  tabId: existing.snapshot.tabId,
                })
                .pipe(Effect.ignore)
            : desktopChannel.closePopup(existing.source, existing.popupId).pipe(Effect.ignore),
        ).catch(constVoid);
      }
      return;
    }
    // Child windows can close while their source is still setting up.
    // Record their lifecycle before awaiting the source page.
    const popup = {
      source,
      popupId: source.popupId,
      hostedOrigins: new Map<string, string>(),
      snapshot: null as PreviewSessionSnapshot | null,
      closed: false,
      closeRequested: false,
      bound: false,
    };
    nativePopups.set(id, popup);
    let opener =
      tabs.get(tabKey(source.threadId, source.tabId)) ??
      (await pendingTabs
        .get(tabKey(source.threadId, source.tabId))
        ?.promise?.catch(() => undefined));
    if (!opener && !popup.closed) {
      const { sessions } = await runPromise(
        manager.list({ threadId: ThreadId.make(source.threadId) }),
      );
      const snapshot = sessions.find(
        (session) =>
          session.tabId === source.tabId &&
          session.runtime === "server" &&
          (session.backingPage === "desktop" ||
            session.backingPage === "desktop-popup" ||
            session.backingPage === "desktop-root") &&
          (session.desktopHostId ?? "local") === (source.desktopHostId ?? "local"),
      );
      if (snapshot) opener = await ensureTab(snapshot).catch(() => undefined);
    }
    if (
      !opener?.desktop ||
      popup.closed ||
      opener.closing ||
      (opener.desktopHostId ?? "local") !== (source.desktopHostId ?? "local")
    ) {
      popup.closeRequested = true;
      if (!popup.closed)
        await runPromise(desktopChannel.closePopup(source, source.popupId)).catch(constVoid);
      if (popup.closed) nativePopups.delete(id);
      return;
    }
    popup.hostedOrigins = new Map(opener.hostedOrigins);
    try {
      const snapshot = await runPromise(
        openTab({
          threadId: opener.threadId,
          ...(/^https?:/i.test(source.url) ? { url: source.url } : {}),
          runtime: "server",
          desktopHostId: source.desktopHostId ?? "local",
          desktopPopup: {
            popupId: source.popupId,
            close: () =>
              Effect.suspend(() => {
                popup.closeRequested = true;
                return desktopChannel.closePopup(source, source.popupId).pipe(
                  Effect.tapError((error) =>
                    Effect.sync(() => {
                      if (error.reason !== "close-canceled") return;
                      popup.closeRequested = false;
                      const tab = popup.snapshot
                        ? tabs.get(tabKey(popup.snapshot.threadId, popup.snapshot.tabId))
                        : undefined;
                      // @effect-diagnostics-next-line globalDateInEffect:off -- Idle cutoff and page activity share this imperative Date.now clock domain.
                      if (tab) tab.usedAt = Date.now();
                      if (tab?.dialog?.type() === "beforeunload") {
                        tab.dialog = null;
                        broadcastControl(tab);
                      }
                    }),
                  ),
                  Effect.mapError(
                    (error) =>
                      new PreviewNativeCloseError({
                        tabId: popup.snapshot!.tabId,
                        reason: error.reason === "close-canceled" ? "canceled" : "unavailable",
                      }),
                  ),
                );
              }),
          },
          ...(opener.profileId === undefined ? {} : { profileId: opener.profileId }),
          ...(opener.control.agentId === null
            ? {}
            : { automationOwner: opener.control.agentId, reveal: false }),
          beforePublish: (snapshot) => {
            popup.snapshot = snapshot;
          },
        }),
      );
      if (popup.closed)
        await runPromise(
          manager.nativeClosedConfirmed({ threadId: opener.threadId, tabId: snapshot.tabId }),
        );
    } catch {
      popup.closeRequested = true;
      if (!popup.closed)
        await runPromise(desktopChannel.closePopup(source, source.popupId)).catch(constVoid);
      if (popup.closed) nativePopups.delete(id);
    }
  };

  const ensureTab = (
    snapshot: PreviewSessionSnapshot,
    newSession = false,
    signal = new AbortController().signal,
  ): Promise<ServerTab> => {
    const key = tabKey(snapshot.threadId, snapshot.tabId);
    const pending = pendingTabs.get(key);
    if (pending?.promise) return pending.promise;
    const existing = tabs.get(key);
    if (existing) return Promise.resolve(existing);
    const native =
      snapshot.backingPage === "desktop" ||
      snapshot.backingPage === "desktop-root" ||
      snapshot.backingPage === "desktop-popup";
    if (native) pendingNativeTabs.add(key);
    const opening = (async () => {
      closeIdleHeadlessTabs();
      if (!native) ensureTabCapacity(newSession ? snapshot.automationOwner : undefined, key);
      if (snapshot.backingPage === "desktop-root" && snapshot.desktopRootId === undefined) {
        await runPromise(
          manager.restoreDesktopRoot({
            threadId: ThreadId.make(snapshot.threadId),
            tabId: snapshot.tabId,
            create: (retained) =>
              createDesktopRoot(retained, signal, (created) => createTab(created, true)),
          }),
          { signal },
        );
        const restored = tabs.get(key);
        if (!restored)
          throw new ServerBrowserTabNotFoundError({
            threadId: snapshot.threadId,
            tabId: snapshot.tabId,
          });
        return restored;
      }
      return createTab(snapshot, !newSession && snapshot.backingPage === "desktop-root");
    })()
      .catch((cause: unknown) => {
        const adopted = adoptedPages.get(key);
        if (adopted) {
          adoptedPages.delete(key);
          void adopted.page.close().catch(constVoid);
        }
        runFork(
          Effect.logWarning(
            isHostSetupError(cause) ? cause.message : "server preview tab failed to start",
            { cause },
          ),
        );
        throw cause;
      })
      .finally(() => {
        pendingTabs.delete(key);
        pendingNativeTabs.delete(key);
        pendingTabOwners.delete(key);
        closedPendingTabs.delete(key);
      });
    pendingTabs.set(key, { agentId: snapshot.automationOwner ?? null, promise: opening });
    if (snapshot.automationOwner !== undefined) pendingTabOwners.set(key, snapshot.automationOwner);
    return opening;
  };

  const createDesktopRoot = (
    snapshot: PreviewSessionSnapshot,
    signal: AbortSignal,
    attach: (snapshot: PreviewSessionSnapshot) => Promise<ServerTab> = (created) =>
      ensureTab(created, true),
  ) =>
    Effect.tryPromise({
      try: async () => {
        if (snapshot.profileId === undefined)
          throw new DesktopBrowserTransportError({ reason: "profile-unavailable" });
        const key = {
          threadId: snapshot.threadId,
          tabId: snapshot.tabId,
          desktopHostId: snapshot.desktopHostId!,
        };
        const root = {
          key,
          automationOwner: snapshot.automationOwner!,
          rootId: null as string | null,
          closed: false,
          closeRequested: false,
          published: false,
        };
        nativeRoots.set(tabKey(snapshot.threadId, snapshot.tabId), root);
        let discarded = false;
        const retireUnpublished = () =>
          Effect.suspend(() => {
            if (root.published) return Effect.void;
            root.closeRequested = true;
            const id = tabKey(snapshot.threadId, snapshot.tabId);
            if (nativeRoots.get(id) === root) nativeRoots.delete(id);
            if (!nativeRoots.has(id)) {
              if (pendingTabs.has(id)) closedPendingTabs.add(id);
              const tab = tabs.get(id);
              if (tab) dropTab(tab, false);
            }
            if (root.rootId === null || root.closed || discarded) return Effect.void;
            discarded = true;
            // Creation already returned this exact native page. Relinquish it without
            // retaining cancellation history or waiting for a disconnected owner's ack.
            return desktopChannel.discardRoot(key, root.rootId);
          });
        try {
          root.rootId = await runPromise(
            desktopChannel.createRoot(key, {
              serverEpoch,
              profileId: snapshot.profileId,
              url: snapshot.navStatus._tag === "Idle" ? "about:blank" : snapshot.navStatus.url,
              ...(snapshot.viewport === undefined ? {} : { viewport: snapshot.viewport }),
            }),
            { signal },
          );
          const cancel = () => {
            runFork(retireUnpublished());
          };
          signal.addEventListener("abort", cancel, { once: true });
          try {
            signal.throwIfAborted();
            await attach({ ...snapshot, desktopRootId: root.rootId });
            await runPromise(desktopChannel.acceptRoot(key, root.rootId), { signal });
          } finally {
            signal.removeEventListener("abort", cancel);
          }
          signal.throwIfAborted();
          if (root.closed) throw new Error("The native browser root closed during creation.");
          return {
            rootId: root.rootId,
            publish: () =>
              Effect.try({
                try: () => {
                  signal.throwIfAborted();
                  if (root.closed)
                    throw new Error("The native browser root closed during creation.");
                },
                catch: (cause) => new PreviewNativeCreateError({ tabId: snapshot.tabId, cause }),
              }).pipe(
                Effect.andThen(
                  desktopChannel
                    .publishRoot(key, root.rootId!)
                    .pipe(
                      Effect.mapError(
                        (cause) => new PreviewNativeCreateError({ tabId: snapshot.tabId, cause }),
                      ),
                    ),
                ),
                Effect.tap(() =>
                  Effect.sync(() => {
                    root.published = true;
                  }),
                ),
              ),
            close: () =>
              Effect.suspend(() => {
                if (!root.published) return retireUnpublished();
                if (root.closed) return Effect.void;
                root.closeRequested = true;
                return desktopChannel.closeRoot(key, root.rootId!, { discardIfOffline: true }).pipe(
                  Effect.tap((outcome) =>
                    Effect.sync(() => {
                      if (outcome !== "discarded") return;
                      // Explicit offline close ends server ownership. Native destruction
                      // waits for reconnect; don't claim a native close acknowledgment.
                      root.closed = true;
                      nativeRoots.delete(tabKey(key.threadId, key.tabId));
                    }),
                  ),
                  Effect.tapError((error) =>
                    Effect.sync(() => {
                      if (error.reason !== "close-canceled") return;
                      root.closeRequested = false;
                      const tab = tabs.get(tabKey(snapshot.threadId, snapshot.tabId));
                      if (tab?.dialog?.type() === "beforeunload") {
                        tab.dialog = null;
                        broadcastControl(tab);
                      }
                    }),
                  ),
                  Effect.mapError(
                    (error) =>
                      new PreviewNativeCloseError({
                        tabId: snapshot.tabId,
                        reason: error.reason === "close-canceled" ? "canceled" : "unavailable",
                      }),
                  ),
                  Effect.asVoid,
                );
              }),
          };
        } catch (cause) {
          await runPromise(retireUnpublished());
          throw cause;
        }
      },
      catch: (cause) => new PreviewNativeCreateError({ tabId: snapshot.tabId, cause }),
    });

  const findTab = Effect.fn("ServerBrowser.findTab")(function* (threadId: string, tabId: string) {
    const existing = tabs.get(tabKey(threadId, tabId));
    if (existing) return existing;
    const { sessions } = yield* manager.list({ threadId: ThreadId.make(threadId) });
    const snapshot = sessions.find(
      (session) => session.tabId === tabId && session.runtime === "server",
    );
    if (!snapshot) return yield* new ServerBrowserTabNotFoundError({ threadId, tabId });
    return yield* Effect.tryPromise({
      try: (signal) => ensureTab(snapshot, false, signal),
      catch: (cause) => (isTabNotFound(cause) ? cause : new ServerBrowserLaunchError({ cause })),
    });
  });

  const pageBudgetUsage = (agentSessionId?: string, candidateKey?: string) => {
    const occupied = new Set([
      ...[...tabs].filter(([, tab]) => tab.desktop === null).map(([key]) => key),
      ...[...pendingTabs.keys()].filter((key) => !pendingNativeTabs.has(key)),
    ]);
    if (candidateKey !== undefined) occupied.delete(candidateKey);
    if (agentSessionId === undefined) return { total: occupied.size, owned: 0 };
    const owned = new Set([
      ...[...tabs.entries()]
        .filter(([, tab]) => tab.desktop === null && tab.control.agentId === agentSessionId)
        .map(([key]) => key),
      ...[...pendingTabOwners.entries()]
        .filter(([key, owner]) => owner === agentSessionId && !pendingNativeTabs.has(key))
        .map(([key]) => key),
    ]);
    if (candidateKey !== undefined) owned.delete(candidateKey);
    return { total: occupied.size, owned: owned.size };
  };

  const nativeBudgetUsage = (agentSessionId: string) => {
    const occupied = new Set([
      ...[...tabs].filter(([, tab]) => tab.desktop !== null).map(([key]) => key),
      ...pendingNativeTabs,
    ]);
    const owned = new Set([
      ...[...tabs]
        .filter(([, tab]) => tab.desktop !== null && tab.control.agentId === agentSessionId)
        .map(([key]) => key),
      ...[...pendingTabOwners]
        .filter(([key, owner]) => owner === agentSessionId && pendingNativeTabs.has(key))
        .map(([key]) => key),
    ]);
    return { total: occupied.size, owned: owned.size };
  };

  // Native paint leases do not prove that a desktop window shows a tab.
  const isVisible = (tab: ServerTab) =>
    tab.viewers.size > 0 || (tab.desktop !== null && desktopChannel.isPresented(tab));

  const ensureNativeTabCapacity = (agentSessionId: string) => {
    const usage = nativeBudgetUsage(agentSessionId);
    if (usage.total >= SERVER_TAB_LIMIT && usage.owned < AGENT_TAB_LIMIT) {
      const cutoff = Date.now() - AGENT_TAB_IDLE_MS;
      const victim = [...tabs.values()]
        .filter(
          (tab) =>
            tab.desktop !== null &&
            tab.control.agentId !== null &&
            !(tab.viewers.size > 0 || desktopChannel.isShown(tab)) &&
            tab.usedAt < cutoff,
        )
        .sort((left, right) => left.usedAt - right.usedAt)[0];
      if (victim) dropTab(victim, true);
    }
    const remaining = nativeBudgetUsage(agentSessionId);
    if (remaining.total >= SERVER_TAB_LIMIT || remaining.owned >= AGENT_TAB_LIMIT)
      throw new BrowserControlInterrupted({
        message: `Too many server browser tabs are open (${AGENT_TAB_LIMIT} per agent session, ${SERVER_TAB_LIMIT} per server). Close one with t3_preview_close or reuse one from preview_status tabs.`,
        reason: "tabLimit",
      });
  };

  const inactiveHeadlessPage = (tab: ServerTab) =>
    tab.desktop === null &&
    tab.viewers.size === 0 &&
    tab.pageActivity === 0 &&
    !tab.recording &&
    !tab.recordingStart &&
    !tab.viewerNavigation &&
    !tab.agentOperating &&
    !tab.loading &&
    !tab.dialog &&
    tab.capturing === 0;

  const ensureTabCapacity = (agentSessionId?: string, candidateKey?: string) => {
    let usage = pageBudgetUsage(agentSessionId, candidateKey);
    while (usage.total >= SERVER_TAB_LIMIT || usage.owned >= AGENT_TAB_LIMIT) {
      const ownedLimit = usage.owned >= AGENT_TAB_LIMIT;
      const victim = [...tabs.entries()]
        .filter(
          ([key, tab]) =>
            key !== candidateKey &&
            inactiveHeadlessPage(tab) &&
            (!ownedLimit || tab.control.agentId === agentSessionId),
        )
        .sort(([, left], [, right]) => left.usedAt - right.usedAt)[0]?.[1];
      if (!victim)
        throw new BrowserControlInterrupted({
          message:
            "The browser is at capacity while its pages are in use. This preview is saved. Retry when an active preview is no longer in use.",
          reason: "tabLimit",
        });
      dropTab(victim, false);
      usage = pageBudgetUsage(agentSessionId, candidateKey);
    }
  };

  // Reserve before manager publication; a launch settles before its capacity is released.
  const openTab = Effect.fn("ServerBrowser.openTab")(function* (
    input: Parameters<typeof manager.open>[0],
    signal?: AbortSignal,
  ) {
    let key: string = NodeCrypto.randomUUID();
    const reservation = { agentId: input.automationOwner ?? null };
    const native = input.desktopHostId !== undefined || input.desktopPopup !== undefined;
    const releaseReservation = () => {
      pendingTabs.delete(key);
      pendingNativeTabs.delete(key);
      pendingTabOwners.delete(key);
    };
    return yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          signal?.throwIfAborted();
          closeIdleHeadlessTabs();
          if (native && input.automationOwner !== undefined)
            ensureNativeTabCapacity(input.automationOwner);
          if (!native) ensureTabCapacity(input.automationOwner);
          pendingTabs.set(key, reservation);
          if (native) pendingNativeTabs.add(key);
          if (input.automationOwner !== undefined) pendingTabOwners.set(key, input.automationOwner);
        },
        catch: ServerBrowserPage.toOperationError,
      }),
      () =>
        manager
          .open({
            ...input,
            beforePublish: (snapshot) => {
              releaseReservation();
              key = tabKey(snapshot.threadId, snapshot.tabId);
              pendingTabs.set(key, reservation);
              if (native) pendingNativeTabs.add(key);
              if (input.automationOwner !== undefined)
                pendingTabOwners.set(key, input.automationOwner);
              input.beforePublish?.(snapshot);
            },
          })
          .pipe(
            Effect.flatMap((snapshot) =>
              Effect.tryPromise({
                try: () => ensureTab(snapshot, true, signal),
                catch: ServerBrowserPage.toOperationError,
              }).pipe(
                Effect.onError(() =>
                  // Explicit environment previews are retained for attachment recovery.
                  input.environmentHosted === true && environmentProfileSessions.has(key)
                    ? Effect.void
                    : manager
                        .close({
                          threadId: ThreadId.make(snapshot.threadId),
                          tabId: snapshot.tabId,
                        })
                        .pipe(Effect.ignore),
                ),
              ),
            ),
          ),
      () => Effect.sync(releaseReservation),
    );
  }, Effect.uninterruptible);

  // Desktop browsing bypasses streamed viewers and server input tracking,
  // so these idle signals only apply to headless tabs.
  const closeIdleHeadlessTabs = () => {
    const cutoff = Date.now() - PAGE_IDLE_MS;
    for (const tab of tabs.values()) {
      if (inactiveHeadlessPage(tab) && tab.usedAt < cutoff) dropTab(tab, false);
    }
  };

  const latestThreadTab = (threadId: string, agentSessionId?: string) => {
    const threadTabs = [...tabs.values()].filter((tab) => tab.threadId === threadId);
    return (
      threadTabs
        .filter((tab) => tab.control.agentId === agentSessionId)
        .sort((left, right) => right.createdAt - left.createdAt)[0] ??
      threadTabs.sort(
        (left, right) =>
          Number(isVisible(right)) - Number(isVisible(left)) || right.usedAt - left.usedAt,
      )[0]
    );
  };

  const tabOwner = (tab: ServerTab) =>
    tab.control.controller !== null
      ? ("human" as const)
      : tab.control.agentId !== null
        ? ("agent" as const)
        : ("unclaimed" as const);

  const resolveReportedProfiles = (input: PreviewReportProfilesInput) => {
    const profiles = resolveBrowserProfiles(input.profiles);
    return {
      profiles,
      defaultProfileId:
        findBrowserProfile(profiles, input.defaultProfileId)?.id ?? DEFAULT_BROWSER_PROFILE_ID,
    };
  };

  // Clients report profiles only when they connect, so the catalog at the last report is
  // kept on disk for agents and scheduled tasks that open a profile after a restart.
  const savedProfilesPath = NodePath.join(
    config.stateDir,
    "server-browser",
    "reported-profiles.json",
  );
  const fileServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const saveProfilesLock = yield* Semaphore.make(1);
  let savedProfiles = yield* (yield* FileSystem.FileSystem).readFileString(savedProfilesPath).pipe(
    Effect.tapError((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.void
        : Effect.logWarning("failed to read saved browser profiles", {
            path: savedProfilesPath,
            cause,
          }),
    ),
    Effect.orElseSucceed(() => ""),
  );
  const reportsByClient = new Map<number, PreviewReportProfilesInput>();
  let nextClient = 0;
  let reportedProfiles: {
    readonly profiles: ReadonlyArray<BrowserProfile>;
    readonly defaultProfileId: string;
  } | null = yield* decodeSavedProfiles(savedProfiles).pipe(
    Effect.map(resolveReportedProfiles),
    Effect.tapError((cause) =>
      savedProfiles === ""
        ? Effect.void
        : Effect.logWarning("ignoring invalid saved browser profiles", {
            path: savedProfilesPath,
            cause,
          }),
    ),
    Effect.orElseSucceed(() => null),
  );
  // Only reports change what is saved, so the order clients disconnect in at shutdown,
  // even while a save waits for the lock, cannot shrink the saved catalog.
  let catalogToSave = reportedProfiles;
  // Agent recordings encode here, so they need the client's Browser recording frame rate. The
  // last report outlives the client, which lets agents record while no client is connected.
  let recordingFrameRate = DEFAULT_BROWSER_RECORDING_FRAME_RATE;

  // Each client reports only the profiles in its own settings, so the catalog is
  // their union while they stay connected. The last catalog stays usable after
  // every client disconnects, as a single report did before.
  const rebuildReportedProfiles = () => {
    const byId = new Map<string, BrowserProfile>();
    let latest: PreviewReportProfilesInput | undefined;
    for (const report of reportsByClient.values()) {
      for (const profile of report.profiles) byId.set(profile.id, profile);
      latest = report;
    }
    if (latest === undefined) return;
    reportedProfiles = resolveReportedProfiles({
      profiles: [...byId.values()],
      defaultProfileId: latest.defaultProfileId,
    });
  };

  const saveReportedProfiles = Effect.fn("ServerBrowser.saveReportedProfiles")(function* () {
    if (catalogToSave === null) return;
    const contents = encodeSavedProfiles({
      profiles: catalogToSave.profiles.filter((profile) => !isBuiltInBrowserProfileId(profile.id)),
      defaultProfileId: catalogToSave.defaultProfileId,
    });
    if (contents === savedProfiles) return;
    yield* writeFileStringAtomically({ filePath: savedProfilesPath, contents }).pipe(
      Effect.provideContext(fileServices),
      Effect.tap(() =>
        Effect.sync(() => {
          savedProfiles = contents;
        }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("failed to save reported browser profiles", { cause }),
      ),
    );
  }, saveProfilesLock.withPermits(1));

  const profileReporter: ServerBrowser["Service"]["profileReporter"] = Effect.acquireRelease(
    Effect.sync(() => nextClient++),
    (client) =>
      Effect.sync(() => {
        reportsByClient.delete(client);
        rebuildReportedProfiles();
      }),
  ).pipe(
    Effect.map(
      (client): ProfileReporter =>
        (input) =>
          Effect.sync(() => {
            if (input.recordingFrameRate !== undefined)
              recordingFrameRate = input.recordingFrameRate;
            reportsByClient.delete(client);
            reportsByClient.set(client, input);
            rebuildReportedProfiles();
            catalogToSave = reportedProfiles;
          }).pipe(
            Effect.andThen(saveReportedProfiles),
            // A disconnect, even while an earlier save holds the lock, must not drop this
            // report's save or leave the saved-content cache stale.
            Effect.uninterruptible,
          ),
    ),
  );

  const profileStatus = (environmentHosted = false) => {
    const profiles = environmentHosted
      ? BUILT_IN_BROWSER_PROFILES
      : (reportedProfiles?.profiles ?? BUILT_IN_BROWSER_PROFILES);
    return {
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        ...(profile.kind === "incognito" ? { incognito: true } : {}),
      })),
      ...(environmentHosted
        ? { defaultProfileId: INCOGNITO_BROWSER_PROFILE_ID }
        : reportedProfiles
          ? { defaultProfileId: reportedProfiles.defaultProfileId }
          : {}),
    };
  };

  /** Environment QA defaults to isolated storage; other opens retain the reported default. */
  const resolveOpenProfile = (
    requested: string | undefined,
    environmentHosted = false,
  ): string | undefined => {
    if (requested === undefined)
      return environmentHosted ? INCOGNITO_BROWSER_PROFILE_ID : reportedProfiles?.defaultProfileId;
    const profiles = environmentHosted
      ? BUILT_IN_BROWSER_PROFILES
      : (reportedProfiles?.profiles ?? BUILT_IN_BROWSER_PROFILES);
    const wanted = requested.toLowerCase();
    const match =
      findBrowserProfile(profiles, requested) ??
      profiles.find((profile) => profile.name.toLowerCase() === wanted);
    if (match) return match.id;
    throw new ServerBrowserPage.ServerBrowserOperationError({
      tag: "PreviewAutomationUnknownProfileError",
      message: `No browser profile is named "${requested}". Use one of: ${profiles
        .map((profile) => `${profile.name} (id ${profile.id})`)
        .join(", ")}.`,
    });
  };

  const loadErrorOf = (tab: ServerTab): PreviewAutomationLoadError | undefined => {
    if (tab.crash) return tab.crash;
    if (!tab.page.url().startsWith("chrome-error://")) return undefined;
    // A desktop failure from before CDP attached is superseded by any navigation we observe.
    if (tab.loadError || !tab.desktop || tab.navigationGeneration > 0) return tab.loadError;
    const reported = desktopChannel.loadFailure({
      threadId: tab.threadId,
      tabId: tab.tabId,
      desktopHostId: tab.desktopHostId,
    });
    return reported && { ...reported, url: ServerBrowserPage.withoutDataPayload(reported.url) };
  };

  const assertNavigationSucceeded = (tab: ServerTab) => {
    const failure = loadErrorOf(tab);
    if (failure) {
      const diagnosticUrl = URL.parse(failure.url);
      if (diagnosticUrl) {
        diagnosticUrl.username = "";
        diagnosticUrl.password = "";
        diagnosticUrl.search = "";
        diagnosticUrl.hash = "";
      }
      const url = diagnosticUrl
        ? ServerBrowserPage.withoutDataPayload(diagnosticUrl.href)
        : "the requested page";
      throw new ServerBrowserPage.ServerBrowserOperationError({
        tag: "PreviewAutomationExecutionError",
        message: `Navigation to ${url} failed: ${failure.description}`,
        detail: { ...failure, url },
      });
    }
  };

  const withinStatusDeadline = <A>(read: Promise<A>, late: () => A): Promise<A> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<A>((resolve) => {
      timer = setTimeout(() => resolve(late()), STATUS_READ_MS);
    });
    return Promise.race([read, deadline]).finally(() => clearTimeout(timer));
  };

  const statusWithTitle = async (
    tab: ServerTab | undefined,
    agentSessionId?: string,
    requestedThreadId?: string,
    requestedTabId?: string,
  ): Promise<PreviewAutomationStatus> => {
    const threadId = tab?.threadId ?? requestedThreadId;
    const listedTabs = [...tabs.values()]
      .filter((candidate) => candidate.threadId === threadId)
      .map((candidate) => ({
        tabId: candidate.tabId,
        url:
          candidate.page.url() === "about:blank"
            ? null
            : (loadErrorOf(candidate)?.url ??
              ServerBrowserPage.withoutDataPayload(candidate.page.url())),
        ...(candidate.openerTabId === undefined ? {} : { openerTabId: candidate.openerTabId }),
        owner: tabOwner(candidate),
        ownedByCaller: candidate.control.agentId === agentSessionId,
        visible: isVisible(candidate),
        ...(candidate.profileId === undefined ? {} : { profileId: candidate.profileId }),
      }));
    // Idle pages and dormant or detached native tabs keep their session without a connected page.
    const detachedRoots = [...nativeRoots.values()].filter(
      (root) =>
        root.published &&
        !root.closed &&
        root.key.threadId === threadId &&
        !tabs.has(tabKey(root.key.threadId, root.key.tabId)),
    );
    let retained: ReadonlyArray<PreviewSessionSnapshot> = [];
    if (threadId !== undefined) {
      const { sessions } = await runPromise(manager.list({ threadId: ThreadId.make(threadId) }));
      retained = sessions.filter(
        (snapshot) =>
          snapshot.runtime === "server" &&
          !tabs.has(tabKey(snapshot.threadId, snapshot.tabId)) &&
          (snapshot.backingPage === "server" ||
            snapshot.backingPage === "desktop" ||
            (snapshot.backingPage === "desktop-root" && snapshot.desktopRootId === undefined) ||
            detachedRoots.some(
              (root) => snapshot.tabId === root.key.tabId && snapshot.desktopRootId === root.rootId,
            )),
      );
      for (const snapshot of retained) {
        listedTabs.push({
          tabId: snapshot.tabId,
          url: snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url,
          owner: snapshot.automationOwner === undefined ? "unclaimed" : "agent",
          ownedByCaller: snapshot.automationOwner === agentSessionId,
          visible: false,
          ...(snapshot.profileId === undefined ? {} : { profileId: snapshot.profileId }),
        });
      }
    }
    if (!tab) {
      const selected = retained.findLast(
        (snapshot) =>
          snapshot.backingPage === "server" &&
          (requestedTabId === undefined
            ? snapshot.automationOwner === agentSessionId
            : snapshot.tabId === requestedTabId),
      );
      const navStatus = selected?.navStatus;
      return {
        available: false,
        visible: false,
        nativePresented: false,
        streamViewers: 0,
        revealRequested: false,
        tabId: selected?.tabId ?? null,
        url: navStatus && navStatus._tag !== "Idle" ? navStatus.url : null,
        title: navStatus && navStatus._tag !== "Idle" ? navStatus.title : null,
        loading: false,
        tabs: listedTabs,
        ...(selected === undefined
          ? {}
          : {
              browserHost: "environment" as const,
              profileId: selected.profileId ?? null,
              viewportSetting: selected.viewport ?? FILL_PREVIEW_VIEWPORT,
            }),
        ...profileStatus(
          selected !== undefined &&
            environmentProfileSessions.has(tabKey(selected.threadId, selected.tabId)),
        ),
      };
    }
    const url = ServerBrowserPage.withoutDataPayload(tab.page.url());
    const loadError = loadErrorOf(tab);
    const statusUrl = loadError?.url ?? (url === "about:blank" ? null : url);
    const [viewport, title] = await Promise.all([
      // A late measurement still lands in desktopViewport for the next status.
      tab.desktop
        ? withinStatusDeadline(desktopStatusViewport(tab), () => tab.desktopViewport)
        : tab.page.viewportSize(),
      statusUrl === null || tab.dialog
        ? null
        : tab.frozen
          ? tab.latestNavigationStatus._tag === "Idle"
            ? null
            : tab.latestNavigationStatus.title || null
          : withinStatusDeadline(
              tab.page.title().catch(() => ""),
              () => "",
            ).then((title) => title || null),
    ]);
    if (tab.desktop)
      tab.nativePresented = desktopChannel.isPresented({
        threadId: tab.threadId,
        tabId: tab.tabId,
        desktopHostId: tab.desktopHostId,
      });
    // A reveal response only confirms the request. Presentation comes from
    // the actual native slot or an attached streamed viewer.
    if (tab.nativePresented || tab.viewers.size > 0) tab.revealRequested = false;
    const desktopHostId = tab.desktop ? (tab.desktopHostId ?? "local") : tab.desktopHostId;
    const catalogue =
      desktopHostId === undefined || agentSessionId === undefined
        ? null
        : await runPromise(
            desktopChannel.getProfiles({ threadId: tab.threadId, agentSessionId, desktopHostId }),
          );
    return {
      profileId: tab.profileId ?? null,
      profileName: tab.desktop
        ? catalogue?.desktopHostId === desktopHostId
          ? (catalogue?.profiles.find((profile) => profile.id === tab.profileId)?.name ?? null)
          : null
        : (BUILT_IN_BROWSER_PROFILES.find((profile) => profile.id === tab.profileId)?.name ?? null),
      available: true,
      browserHost: tab.desktop ? ("desktop" as const) : ("environment" as const),
      visible: isVisible(tab),
      nativePresented: tab.nativePresented,
      streamViewers: tab.viewers.size,
      revealRequested: tab.revealRequested,
      tabId: tab.tabId,
      url: statusUrl,
      title,
      loading: tab.loading,
      ...(loadError ? { loadError } : {}),
      control: {
        owner: tabOwner(tab),
        ownedByCaller: tab.control.agentId === agentSessionId,
        generation: tab.control.generation,
      },
      dialog: dialogStatus(tab),
      fileChooser: tab.fileChooser
        ? { multiple: tab.fileChooser.chooser.isMultiple(), accept: tab.fileChooser.accept }
        : null,
      viewportSetting: tab.setting,
      ...(viewport ? { viewport } : {}),
      tabs: listedTabs,
      ...profileStatus(environmentProfileSessions.has(tabKey(tab.threadId, tab.tabId))),
      downloads: tab.downloads.map(({ fileName, path, sizeBytes, url, completedAt }) => ({
        fileName,
        path,
        sizeBytes,
        url,
        completedAt,
      })),
    };
  };

  const resolveNavigationUrl = (input: PreviewAutomationNavigateInput) => {
    if (input.url !== undefined) return normalizePreviewUrl(input.url);
    const target = input.target!;
    if (target.kind === "url") return normalizePreviewUrl(target.url);

    const path = target.path ?? "";
    return `${target.protocol ?? "http"}://localhost:${target.port}${path.startsWith("/") || path === "" ? path : `/${path}`}`;
  };

  /** A pending dialog also leaves the probe unanswered, but its script is waiting, not stuck. */
  const leaveBusyPage = (tab: ServerTab, cdp: CDPSession, budgetMs?: number) =>
    tab.dialog ? Promise.resolve() : ServerBrowserPage.stopUnresponsiveScript(cdp, budgetMs);

  const navigate = async (
    tab: ServerTab,
    destination: Parameters<typeof hostedRunChanged>[1],
    readiness: "load" | "domContentLoaded" | "none",
    timeout: number,
    signal: AbortSignal,
    onCommitted?: () => void,
  ) => {
    tab.pendingInitialRequestUrl = null;
    const { url } = destination;
    const runChanged = hostedRunChanged(tab, destination);
    const started = serviceClock.monotonicTimeNanosUnsafe();
    const navigationOptions = () => {
      signal.throwIfAborted();
      const remaining =
        timeout - Number(serviceClock.monotonicTimeNanosUnsafe() - started) / 1_000_000;
      if (remaining <= 0)
        throw new ServerBrowserPage.ServerBrowserOperationError({
          tag: "PreviewAutomationTimeoutError",
          message: "The browser operation exceeded its execution deadline.",
        });
      return {
        timeout: Math.max(1, remaining),
        waitUntil: "commit",
      } as const;
    };
    const release = await acquireHostingDestination(tab, url);
    const navigation = Promise.resolve()
      .then(async () => {
        await leaveBusyPage(tab, tab.cdp, navigationOptions().timeout / 2);
        const response = await tab.page.goto(url, navigationOptions());
        // A fragment navigation can succeed while retaining the previous app's document.
        if (response === null && runChanged) await tab.page.reload(navigationOptions());
      })
      .then(() => onCommitted?.())
      .finally(release);
    if (readiness === "none") {
      tab.control.track(navigation);
      return;
    }
    // Once the target commits, a stalled subresource only delays readiness; report the loading tab.
    const ready = () =>
      tab.page
        .waitForLoadState(readiness === "domContentLoaded" ? "domcontentloaded" : "load", {
          timeout: Math.max(
            1,
            timeout - Number(serviceClock.monotonicTimeNanosUnsafe() - started) / 1_000_000,
          ),
        })
        .catch((cause: unknown) => {
          if (!(cause instanceof Error && cause.name === "TimeoutError")) throw cause;
        });
    await navigation.then(ready).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("Download is starting")) {
        throw new ServerBrowserPage.ServerBrowserOperationError({
          tag: "PreviewAutomationExecutionError",
          message: `${url} is a file this browser cannot show, so it was downloaded instead. preview_status lists it under downloads.`,
        });
      }
      if (/ERR_[A-Z_]+/.test(message)) {
        throw new ServerBrowserPage.ServerBrowserOperationError({
          tag: "PreviewAutomationExecutionError",
          message: `Navigation to ${url} failed: ${ServerBrowserPage.parseNetError(message).description}`,
        });
      }
      throw ServerBrowserPage.toOperationError(cause, timeout);
    });
    assertNavigationSucceeded(tab);
  };

  const withCaptureLock = <A>(tab: ServerTab, operation: () => Promise<A>): Promise<A> => {
    const run = tab.captureLock.then(() => {
      if (tab.closing) throw new Error("The preview tab closed.");
      return operation();
    });
    tab.captureLock = run.then(constVoid, constVoid);
    return run;
  };

  const startRecording = (
    tab: ServerTab,
    signal: AbortSignal,
    remainingTimeoutMs: () => number,
    releaseRequestSurface?: () => Promise<void>,
  ): Promise<Recording> => {
    const started = withCaptureLock(tab, async () => {
      signal.throwIfAborted();
      if (tab.recording) return tab.recording;
      let active = true;
      let published = false;
      const resources = { encoder: null as Page | null, session: null as CDPSession | null };
      let releaseSurface = async () => {};
      const assertActive = () => {
        signal.throwIfAborted();
        if (!active || tab.closing)
          throw new BrowserControlInterrupted({
            message: "The recording start was interrupted.",
          });
      };
      try {
        return await ServerBrowserPage.withReadBudget(
          { signal, timeoutMs: remainingTimeoutMs() },
          async (read) => {
            await read("recording surface", async () => {
              const release = await acquirePersistentNativeSurface(tab, {
                signal,
                timeoutMs: remainingTimeoutMs(),
              });
              if (!active || signal.aborted) {
                await release();
                assertActive();
              }
              releaseSurface = release;
            });
            const openedEncoder = await read("recording encoder", () =>
              contexts.scratchPage().then((page) => {
                if (!active || signal.aborted) {
                  void page.close().catch(constVoid);
                  assertActive();
                }
                resources.encoder = page;
                return page;
              }),
            );
            await read("recording encoder setup", () =>
              openedEncoder.evaluate(ServerBrowserPage.recordingEncoderScript(recordingFrameRate)),
            );
            const firstFrame = await read("recording seed frame", () =>
              ServerBrowserPage.captureViewport(tab.cdp, {
                format: "jpeg",
                quality: RECORDING_SCREENCAST.quality,
                signal,
                timeoutMs: remainingTimeoutMs(),
              }),
            );
            const width = (
              await read("recording seed layout", () =>
                ServerBrowserPage.viewportSize(tab.page, tab.cdp),
              )
            ).width;
            await read("recording seed encoder", () =>
              openedEncoder.evaluate(
                ([data, width]) =>
                  (globalThis as unknown as EncoderWindow).__t3Recorder.frame(data, width),
                [firstFrame, width] as const,
              ),
            );
            const opened = await read("recording CDP session", () =>
              tab.page
                .context()
                .newCDPSession(tab.page)
                .then((opened) => {
                  if (!active || signal.aborted) {
                    void opened.detach().catch(constVoid);
                    assertActive();
                  }
                  resources.session = opened;
                  return opened;
                }),
            );
            const framesInFlight = new Set<Promise<void>>();
            // Chrome withholds frames while acks are outstanding, so ack on arrival and let a
            // slow encoder skip to the newest frame instead of throttling the capture.
            let pendingFrame: readonly [string, number] | null = null;
            const deliverPending = async () => {
              while (pendingFrame) {
                const next = pendingFrame;
                pendingFrame = null;
                const accepted = await openedEncoder
                  .evaluate(
                    ([data, width]) =>
                      (globalThis as unknown as EncoderWindow).__t3Recorder.frame(data, width),
                    next,
                  )
                  .catch(() => true);
                if (!accepted) {
                  pendingFrame = null;
                  await opened.send("Page.stopScreencast").catch(constVoid);
                }
              }
            };
            opened.on("Page.screencastFrame", (frame) => {
              if (!active) return;
              void opened
                .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
                .catch(constVoid);
              const cssWidth = tab.page.viewportSize()?.width ?? frame.metadata.deviceWidth;
              const delivering = framesInFlight.size > 0;
              pendingFrame = [frame.data, cssWidth];
              if (delivering) return;
              const delivered: Promise<void> = deliverPending().finally(() =>
                framesInFlight.delete(delivered),
              );
              framesInFlight.add(delivered);
            });
            assertActive();
            await read("recording screencast start", () =>
              opened.send("Page.startScreencast", RECORDING_SCREENCAST),
            );
            assertActive();
            const recording: Recording = {
              encoder: openedEncoder,
              session: opened,
              startedAt: new Date().toISOString(),
              framesInFlight,
              releaseSurface,
            };
            tab.recording = recording;
            published = true;
            return recording;
          },
        );
      } finally {
        if (!published) {
          active = false;
          await releaseRequestSurface?.();
          const { encoder, session } = resources;
          const closedEncoder = encoder?.close().catch(constVoid);
          if (encoder || session)
            await withNativeCleanup(tab, () =>
              Promise.all([
                closedEncoder,
                session
                  ?.send("Page.stopScreencast")
                  .catch(constVoid)
                  .then(() => session?.detach().catch(constVoid)),
              ]),
            );
          void session?.detach().catch(constVoid);
          await releaseSurface();
        }
      }
    }).finally(() => {
      if (tab.recordingStart === started) tab.recordingStart = null;
    });
    tab.recordingStart = started;
    return started;
  };

  const withScreencastsPaused = <A>(
    tab: ServerTab,
    capture: () => Promise<A>,
    signal: AbortSignal,
    remainingTimeoutMs: () => number,
    releaseRequestSurface?: () => Promise<void>,
  ): Promise<A> =>
    withCaptureLock(tab, async () => {
      signal.throwIfAborted();
      tab.capturing += 1;
      const recording = tab.recording;
      try {
        await ServerBrowserPage.withReadBudget(
          { signal, timeoutMs: remainingTimeoutMs() },
          (read) =>
            read("pause screencasts", () =>
              Promise.all([
                ...[...tab.viewers].map((viewer) => viewer.pause(signal, remainingTimeoutMs())),
                recording?.session.send("Page.stopScreencast"),
              ]),
            ),
        );
        signal.throwIfAborted();
        return await capture();
      } finally {
        tab.capturing -= 1;
        // Cleanup gets its own short native lease after the expired request lease leaves.
        await releaseRequestSurface?.();
        if (tab.viewers.size > 0 || (recording && tab.recording === recording)) {
          await withNativeCleanup(tab, () =>
            Promise.all([
              ...[...tab.viewers].map((viewer) => viewer.resume(400)),
              recording && tab.recording === recording
                ? recording.session.send("Page.startScreencast", RECORDING_SCREENCAST)
                : undefined,
            ]),
          );
        }
      }
    });

  const stopRecording = (
    tab: ServerTab,
    signal: AbortSignal,
    remainingTimeoutMs: () => number,
    releaseRequestSurface?: () => Promise<void>,
  ) =>
    withCaptureLock(tab, () =>
      ServerBrowserPage.withReadBudget(
        { signal, timeoutMs: remainingTimeoutMs() },
        async (read) => {
          const recording = tab.recording;
          if (!recording) {
            throw new ServerBrowserPage.ServerBrowserOperationError({
              tag: "PreviewAutomationRecordingNotActiveError",
              message: "No recording is active for this tab.",
            });
          }
          try {
            await read("recording screencast stop", () =>
              recording.session.send("Page.stopScreencast"),
            );
            await read("recording final frames", () => Promise.all(recording.framesInFlight));
            await read("recording session detach", () => recording.session.detach());
            // A screencast can miss the last paint when the page goes idle.
            if (!tab.closing && !tab.dialog) {
              const finalFrame = await read("recording final paint", () =>
                ServerBrowserPage.captureFinalRecordingFrame(
                  tab.cdp,
                  RECORDING_SCREENCAST.quality,
                  { signal, timeoutMs: remainingTimeoutMs() },
                ),
              );
              if (finalFrame !== undefined) {
                const { width } = await read("recording final layout", () =>
                  ServerBrowserPage.viewportSize(tab.page, tab.cdp),
                );
                await read("recording final frame", () =>
                  recording.encoder
                    .evaluate(
                      ([data, width]) =>
                        (globalThis as unknown as EncoderWindow).__t3Recorder.frame(data, width),
                      [finalFrame, width] as const,
                    )
                    .catch(constVoid),
                );
              }
            }
            const stopped = await read("recording encoder stop", () =>
              recording.encoder.evaluate(() =>
                (globalThis as unknown as EncoderWindow).__t3Recorder.stop(),
              ),
            );
            // Checked before the transfer so an oversized video never lands in this process.
            if (stopped.bytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
              throw new ServerBrowserPage.ServerBrowserOperationError({
                tag: "PreviewAutomationRecordingTooLargeError",
                message: "The recording is larger than the attachment limit.",
              });
            }
            if (!stopped.mimeType || stopped.bytes === 0) {
              throw new ServerBrowserPage.ServerBrowserOperationError({
                tag: "PreviewAutomationExecutionError",
                message: "The recording captured no frames.",
              });
            }
            const extension = stopped.mimeType.startsWith("video/mp4") ? "mp4" : "webm";
            const pendingId = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${NodeCrypto.randomUUID()}-${extension}`;
            const path = NodePath.join(config.attachmentsDir, `${pendingId}.${extension}`);
            await read("recording directory", () =>
              NodeFSP.mkdir(config.attachmentsDir, { recursive: true }),
            );
            if (stopped.bytes >= RECORDING_BINARY_EXPORT_MIN_BYTES) {
              const stagedPath = `${path}.partial`;
              try {
                const [download] = await read("recording download", (timeoutMs) =>
                  Promise.all([
                    recording.encoder.waitForEvent("download", {
                      timeout: Math.min(RECORDING_DOWNLOAD_TIMEOUT_MS, timeoutMs),
                    }),
                    recording.encoder.evaluate(() =>
                      (globalThis as unknown as EncoderWindow).__t3Recorder.download(),
                    ),
                  ]),
                );
                await read("recording download save", () => download.saveAs(stagedPath));
                if (
                  (await read("recording download size", () => NodeFSP.stat(stagedPath))).size !==
                  stopped.bytes
                ) {
                  throw new Error("The recording download is incomplete.");
                }
                await read("recording download commit", () => NodeFSP.rename(stagedPath, path));
              } finally {
                await NodeFSP.rm(stagedPath, { force: true }).catch(constVoid);
              }
            } else {
              const chunks: Array<Buffer> = [];
              for (let index = 0; index < stopped.count; index += 1) {
                const chunk = await read("recording chunk", () =>
                  recording.encoder.evaluate(
                    (chunkIndex) =>
                      (globalThis as unknown as EncoderWindow).__t3Recorder.chunk(chunkIndex),
                    index,
                  ),
                );
                chunks.push(Buffer.from(chunk, "base64"));
              }
              const data = Buffer.concat(chunks);
              if (data.byteLength !== stopped.bytes)
                throw new Error("The recording transfer is incomplete.");
              await read("recording write", () => NodeFSP.writeFile(path, data));
            }
            return {
              id: pendingId,
              tabId: tab.tabId,
              path,
              mimeType: stopped.mimeType.split(";")[0]!,
              sizeBytes: stopped.bytes,
              createdAt: new Date().toISOString(),
              uploadedAttachmentId: pendingId,
            };
          } finally {
            tab.recording = null;
            await releaseRequestSurface?.();
            const closedEncoder = recording.encoder.close().catch(constVoid);
            await withNativeCleanup(tab, () =>
              Promise.all([
                closedEncoder,
                recording.session
                  .send("Page.stopScreencast")
                  .catch(constVoid)
                  .then(() => recording.session.detach().catch(constVoid)),
              ]),
            );
            void recording.session.detach().catch(constVoid);
            await recording.releaseSurface();
          }
        },
      ),
    );

  let pointerSequence = 0;
  const pointerFor =
    (tab: ServerTab): ServerBrowserPage.PointerReporter =>
    async ({ x, y }, phase) => {
      const encoder = tab.recording?.encoder;

      if (tab.viewers.size === 0 && !encoder && !tab.desktop) return;
      const show = (next: "move" | "click") => {
        const sequence = ++pointerSequence;
        for (const viewer of tab.viewers)
          viewer.push({ _tag: "pointer", phase: next, x, y, sequence });
        if (tab.desktop)
          runFork(
            desktopChannel.pointer(
              {
                threadId: tab.threadId,
                tabId: tab.tabId,
                ...(tab.desktopHostId === undefined ? {} : { desktopHostId: tab.desktopHostId }),
              },
              { phase: next, x, y },
            ),
          );
        void encoder
          ?.evaluate(
            ([px, py, click]) =>
              (globalThis as unknown as EncoderWindow).__t3Recorder?.cursor(px, py, click),
            [x, y, next === "click"] as const,
          )
          .catch(constVoid);
      };
      show("move");
      await sleepUntil(Date.now() + AGENT_CURSOR_MOVE_MS);
      if (phase !== "click") return;
      show("click");
      await sleepUntil(Date.now() + AGENT_CURSOR_CLICK_LEAD_MS);
    };

  const recordAction = <A>(tab: ServerTab, action: string, run: () => Promise<A>): Promise<A> => {
    const event: {
      -readonly [K in keyof PreviewAutomationActionEvent]: PreviewAutomationActionEvent[K];
    } = {
      id: NodeCrypto.randomUUID(),
      action,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    pushBounded(tab.actionTimeline, event, ACTION_TIMELINE_LIMIT);
    return run().then(
      (result) => {
        event.status = "succeeded";
        event.completedAt = new Date().toISOString();
        return result;
      },
      (cause: unknown) => {
        event.status = "failed";
        event.completedAt = new Date().toISOString();
        event.error = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
        throw cause;
      },
    );
  };

  const requireTab = async (request: PreviewAutomationRequest, signal: AbortSignal) => {
    if (!request.agentSessionId)
      throw new BrowserControlInterrupted({
        message: "The agent session is missing. Reconnect the provider.",
      });
    const owned = [...tabs.values()].filter(
      (tab) => tab.threadId === request.threadId && tab.control.agentId === request.agentSessionId,
    );
    if (!request.tabIdExplicit && owned.length > 1)
      throw new BrowserControlInterrupted({
        message:
          "Multiple tabs belong to this agent session. Pass a tabId from preview_open or preview_status tabs.",
        reason: "tabRequired",
      });
    const tab =
      request.tabId === undefined
        ? latestThreadTab(request.threadId, request.agentSessionId)
        : await runPromise(
            findTab(request.threadId, request.tabId).pipe(Effect.orElseSucceed(constVoid)),
            { signal },
          );
    if (!tab) {
      throw new ServerBrowserPage.ServerBrowserOperationError({
        tag: "PreviewAutomationTabNotFoundError",
        message: "No server preview tab is open for this thread. Call preview_open first.",
      });
    }
    if (!READ_OPERATIONS.has(request.operation) && !tab.control.agentMayAct(request.agentSessionId))
      throw new BrowserControlInterrupted({
        message:
          "This tab belongs to another agent session. You can read it, but open your own tab to act.",
        reason: "agentMismatch",
      });
    return tab;
  };

  const markUsed = (request: PreviewAutomationRequest) => {
    const now = Date.now();
    for (const tab of tabs.values()) {
      if (
        tab.threadId === request.threadId &&
        (tab.control.agentId === request.agentSessionId || tab.tabId === request.tabId)
      )
        tab.usedAt = now;
    }
  };

  const browserNavigationUrl = async (
    target: {
      readonly threadId: string;
      readonly desktopHostId?: string | undefined;
      readonly hostedOrigins?: ReadonlyMap<string, string>;
    },
    url: string,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    let localUrl = url;
    const requested = new URL(url);
    const localOrigin = target.hostedOrigins?.get(requested.origin);
    const sharedHttps = localOrigin !== undefined && requested.protocol === "https:";
    if (localOrigin !== undefined) {
      const local = new URL(localOrigin);
      requested.protocol = local.protocol;
      requested.host = local.host;
      localUrl = requested.href;
    }
    let destination = url;
    // The verified shared HTTPS listener owns its hostname and certificate;
    // the desktop's control-channel address cannot replace that origin.
    if (target.desktopHostId !== undefined && target.desktopHostId !== "local" && !sharedHttps) {
      const resolved = await runPromise(
        desktopChannel.resolveUrl({
          desktopHostId: target.desktopHostId,
          threadId: target.threadId,
          url: localUrl,
        }),
        { signal },
      );
      signal?.throwIfAborted();
      if (resolved === null)
        throw new ServerBrowserPage.ServerBrowserOperationError({
          tag: "PreviewAutomationRemoteUnavailableError",
          message:
            "The connected desktop cannot resolve this environment URL. Check the environment connection before retrying; the desktop's localhost was not opened.",
        });
      destination = normalizePreviewUrl(resolved);
    }
    const prepared = await runPromise(
      hosting
        .prepareNavigation({
          threadId: target.threadId,
          url: localUrl,
          ...(destination === localUrl ? {} : { browserUrl: destination }),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ServerBrowserPage.ServerBrowserOperationError({
                tag: "PreviewAutomationExecutionError",
                message:
                  cause._tag === "PreviewHostingAuthError" || cause._tag === "PreviewHostingError"
                    ? cause.message
                    : "The saved development preview could not be prepared for browser navigation.",
              }),
          ),
        ),
      { signal },
    );
    signal?.throwIfAborted();
    return { ...prepared, url: destination, localUrl: prepared.localUrl ?? localUrl };
  };

  const prepareBrowserCredential = async (
    tab: ServerTab,
    destination: Awaited<ReturnType<typeof browserNavigationUrl>>,
    signal?: AbortSignal,
    timeoutMs = NAVIGATION_TIMEOUT_MS,
  ) => {
    signal?.throwIfAborted();
    if (destination.managed) {
      await runPromise(
        manager.rememberHostedOrigin({
          threadId: tab.threadId,
          tabId: tab.tabId,
          browserUrl: destination.url,
          localUrl: destination.localUrl,
        }),
        { signal },
      );
      tab.hostedOrigins.set(new URL(destination.url).origin, new URL(destination.localUrl).origin);
    }
    if (destination.bootstrapToken === undefined) return;
    await ServerBrowserPage.prepareBrowserCredential(
      tab.page,
      destination.url,
      destination.bootstrapToken,
      timeoutMs,
    );
    signal?.throwIfAborted();
  };

  const renewPreviewAssetUrl = async (
    tab: ServerTab,
    url: string,
    minimumValidityMs?: number,
    signal?: AbortSignal,
  ) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return url;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return url;
    const configuredHost = (config.host ?? "127.0.0.1").replace(/^\[|\]$/g, "");
    const localListener =
      isLocalLoopbackHost(configuredHost) ||
      configuredHost === "0.0.0.0" ||
      configuredHost === "::";
    const ownOrigin =
      target.origin === config.devUrl?.origin ||
      (target.protocol === "http:" &&
        (config.port === 0 || Number(target.port || 80) === config.port) &&
        (localListener
          ? isLocalLoopbackHost(target.hostname)
          : target.hostname.replace(/^\[|\]$/g, "") === configuredHost));
    if (!ownOrigin && !tab.desktop && config.port === 0) return url;
    const canonicalHost =
      configuredHost === "0.0.0.0" ? "127.0.0.1" : configuredHost === "::" ? "::1" : configuredHost;
    // Native pages keep their reachable origin; the environment's signature still gates renewal.
    const canonicalOrigin =
      ownOrigin || tab.desktop
        ? undefined
        : `http://${canonicalHost.includes(":") ? `[${canonicalHost}]` : canonicalHost}:${config.port}`;
    return runPromise(
      AssetAccess.renewPreviewAssetUrl(url, minimumValidityMs, canonicalOrigin).pipe(
        Effect.provideService(AssetSigner.AssetSigner, assetSigner),
        Effect.provideService(Clock.Clock, serviceClock),
      ),
      { signal },
    );
  };

  const prepareRetainedBrowserNavigation = async (
    tab: ServerTab,
    url: string,
    signal?: AbortSignal,
    minimumAssetValidityMs?: number,
  ) => {
    url = await renewPreviewAssetUrl(tab, url, minimumAssetValidityMs, signal);
    if (!/^https?:/i.test(url)) return { url, restarted: false, runId: undefined };
    const prepareUnmapped = async () => {
      const prepared = await runPromise(
        hosting.prepareNavigation({ threadId: tab.threadId, url }),
        {
          signal,
        },
      );
      return { ...prepared, url, localUrl: prepared.localUrl ?? url };
    };
    const destination = tab.hostedOrigins.has(new URL(url).origin)
      ? await browserNavigationUrl(tab, url, signal)
      : await prepareUnmapped();
    await prepareBrowserCredential(tab, destination, signal);
    return {
      url: destination.url,
      restarted: destination.restarted === true,
      runId: destination.runId,
    };
  };

  const prepareExistingBrowserNavigation = async (
    tab: ServerTab,
    url: string,
    signal?: AbortSignal,
  ) => prepareRetainedBrowserNavigation(tab, url, signal);

  const startViewerNavigation = (
    tab: ServerTab,
    run: (signal: AbortSignal) => Promise<unknown>,
    url = tab.page.url(),
  ) => {
    tab.viewerNavigation?.abort(new BrowserControlInterrupted());
    const controller = new AbortController();
    tab.viewerNavigation = controller;
    const work = withHostedDestination(tab, url, () => run(controller.signal));
    tab.control.trackUntilHandoff(work);
    void work.catch(constVoid).finally(() => {
      if (tab.viewerNavigation === controller) tab.viewerNavigation = null;
    });
  };

  const profileHost = async (request: PreviewAutomationRequest) => {
    if (!request.agentSessionId) return { desktopHostId: undefined, environmentHosted: false };
    const owned = [...tabs.values()].filter(
      (tab) => tab.threadId === request.threadId && tab.control.agentId === request.agentSessionId,
    );
    const current =
      request.tabIdExplicit && request.tabId !== undefined
        ? tabs.get(tabKey(request.threadId, request.tabId))
        : owned.find((tab) => tab.tabId === request.tabId);
    if (current)
      return {
        desktopHostId: current.desktop ? (current.desktopHostId ?? "local") : undefined,
        environmentHosted: environmentProfileSessions.has(tabKey(current.threadId, current.tabId)),
      };
    if (request.tabId !== undefined) {
      const { sessions } = await runPromise(manager.list({ threadId: request.threadId }));
      const retained = sessions.find(
        (session) =>
          session.tabId === request.tabId &&
          (request.tabIdExplicit || session.automationOwner === request.agentSessionId),
      );
      if (
        retained?.backingPage === "desktop" ||
        retained?.backingPage === "desktop-popup" ||
        retained?.backingPage === "desktop-root"
      )
        return { desktopHostId: retained.desktopHostId ?? "local", environmentHosted: false };
      if (retained)
        return {
          desktopHostId: undefined,
          environmentHosted: environmentProfileSessions.has(
            tabKey(request.threadId, retained.tabId),
          ),
        };
      if (request.tabIdExplicit)
        throw new ServerBrowserPage.ServerBrowserOperationError({
          tag: "PreviewAutomationTabNotFoundError",
          message:
            "The requested preview tab is unavailable to this agent session. Omit tabId to open a new tab.",
        });
    }
    const latest = owned.sort((left, right) => right.createdAt - left.createdAt)[0];
    return {
      desktopHostId: latest?.desktop ? (latest.desktopHostId ?? "local") : undefined,
      environmentHosted:
        latest !== undefined &&
        environmentProfileSessions.has(tabKey(latest.threadId, latest.tabId)),
    };
  };

  const runOperationUnprotected = async (
    request: PreviewAutomationRequest,
    signal: AbortSignal,
    remainingTimeoutMs: () => number,
    deadlineMs: number,
  ): Promise<unknown> => {
    signal.throwIfAborted();
    const input = request.input;
    switch (request.operation) {
      case "status":
        return statusWithTitle(
          request.tabId === undefined
            ? latestThreadTab(request.threadId, request.agentSessionId)
            : (tabs.get(tabKey(request.threadId, request.tabId)) ??
                (adoptedPages.has(tabKey(request.threadId, request.tabId)) ||
                pendingTabs.has(tabKey(request.threadId, request.tabId))
                  ? await runPromise(findTab(request.threadId, request.tabId), { signal })
                  : undefined)),
          request.agentSessionId,
          request.threadId,
          request.tabId,
        );
      case "profiles": {
        const { desktopHostId } = await profileHost(request);
        const profiles = await runPromise(
          desktopChannel.getProfiles({
            threadId: request.threadId,
            agentSessionId: request.agentSessionId ?? "",
            ...(desktopHostId === undefined ? {} : { desktopHostId }),
          }),
        );
        if (profiles === null)
          throw new ServerBrowserPage.ServerBrowserOperationError({
            tag: "PreviewAutomationRemoteUnavailableError",
            message:
              "No unambiguous connected desktop profile catalogue is available. Connect the desktop that owns the desired profile, then call preview_profiles again.",
          });
        return { profiles: profiles.profiles, defaultProfileId: profiles.defaultProfileId };
      }
      case "open":
      case "openWithProfile": {
        if (!request.agentSessionId)
          throw new BrowserControlInterrupted({
            message: "The agent session is missing. Reconnect the provider.",
          });
        const open = input as PreviewAutomationOpenInput;
        const currentHost =
          open.browserHost === "environment" ? undefined : await profileHost(request);
        const environmentHosted =
          open.browserHost === "environment" ||
          (open.browserHost === undefined && currentHost?.environmentHosted === true);
        const desktopHostId = environmentHosted ? undefined : currentHost?.desktopHostId;
        const catalogue = environmentHosted
          ? null
          : await runPromise(
              desktopChannel.getProfiles({
                threadId: request.threadId,
                agentSessionId: request.agentSessionId,
                ...(desktopHostId === undefined ? {} : { desktopHostId }),
              }),
            );
        // Reported web profiles remain available for environment-hosted pages. An
        // explicit desktop-profile operation must still use its owning desktop.
        const useReportedProfile =
          environmentHosted ||
          (open.browserHost !== "desktop" &&
            desktopHostId === undefined &&
            catalogue === null &&
            request.operation === "open" &&
            (reportedProfiles !== null || !desktopChannel.available));
        const reportedProfileId = useReportedProfile
          ? resolveOpenProfile(open.profileId ?? open.profileName, environmentHosted)
          : undefined;
        let selectedProfileId =
          environmentHosted && (open.profileId !== undefined || open.profileName !== undefined)
            ? reportedProfileId
            : undefined;
        if (
          !useReportedProfile &&
          (open.profileId !== undefined || open.profileName !== undefined)
        ) {
          if (catalogue === null)
            throw new ServerBrowserPage.ServerBrowserOperationError({
              tag: "PreviewAutomationRemoteUnavailableError",
              message:
                "The desktop owning the requested browser profile is unavailable or ambiguous. Call preview_profiles after connecting the intended desktop.",
            });
          const requestedId = open.profileId;
          const exactProfile = catalogue.profiles.find((profile) => profile.id === requestedId);
          const matches = exactProfile
            ? [exactProfile]
            : catalogue.profiles.filter((profile) =>
                requestedId !== undefined
                  ? profile.name.toLowerCase() === requestedId.toLowerCase()
                  : profile.name === open.profileName,
              );
          if (matches.length !== 1) {
            const reason = matches.length === 0 ? "unknown" : "ambiguous";
            const detail =
              matches.length === 0
                ? `Browser profile ${JSON.stringify(open.profileId ?? open.profileName)} does not exist. Call preview_profiles to list available profiles.`
                : `Browser profile name ${JSON.stringify(open.profileName)} matches multiple profiles. Use profileId: ${matches.map((profile) => JSON.stringify(profile.id)).join(", ")}.`;
            throw new ServerBrowserPage.ServerBrowserOperationError({
              tag: "PreviewAutomationProfileError",
              message: detail,
              detail: { reason, detail },
            });
          }
          selectedProfileId = matches[0]!.id;
        }
        const newTabProfileId =
          selectedProfileId ?? catalogue?.defaultProfileId ?? reportedProfileId;
        const initialUrl = open.url === undefined ? undefined : normalizePreviewUrl(open.url);
        const reuse = open.reuseExistingTab ?? true;
        if (
          reuse &&
          !request.tabIdExplicit &&
          [...tabs.values()].filter(
            (tab) =>
              tab.threadId === request.threadId && tab.control.agentId === request.agentSessionId,
          ).length > 1
        )
          throw new BrowserControlInterrupted({
            message: "Multiple tabs are open. Pass tabId or reuseExistingTab=false.",
            reason: "tabRequired",
          });
        // Check retained ownership before attachment: a host switch must not
        // wait for the disconnected desktop page it is replacing.
        let differentRetainedHost = false;
        if (reuse && request.tabId !== undefined && open.browserHost !== undefined) {
          const attached = tabs.get(tabKey(request.threadId, request.tabId));
          const retained = attached
            ? undefined
            : (await runPromise(manager.list({ threadId: request.threadId }))).sessions.find(
                (session) => session.tabId === request.tabId && session.runtime === "server",
              );
          const retainedHost = attached
            ? attached.desktop
              ? "desktop"
              : "environment"
            : retained
              ? retained.backingPage === "desktop" ||
                retained.backingPage === "desktop-popup" ||
                retained.backingPage === "desktop-root"
                ? "desktop"
                : "environment"
              : undefined;
          differentRetainedHost = retainedHost !== undefined && retainedHost !== open.browserHost;
          if (differentRetainedHost && request.tabIdExplicit)
            throw new ServerBrowserPage.ServerBrowserOperationError({
              tag: "PreviewAutomationExecutionError",
              message:
                "The selected tab uses a different browser host. Omit tabId to create a new tab; an existing tab cannot switch hosts.",
            });
        }
        // A tab still launching exists only as a session, so resolve it like a viewer would.
        const found =
          reuse && request.tabId !== undefined && !differentRetainedHost
            ? await runPromise(
                findTab(request.threadId, request.tabId).pipe(
                  Effect.catchTags({
                    ServerBrowserTabNotFoundError: () => Effect.void,
                  }),
                ),
                { signal },
              )
            : undefined;
        if (reuse && request.tabIdExplicit && !found) {
          const { sessions } = await runPromise(
            manager.list({ threadId: ThreadId.make(request.threadId) }),
          );
          const desktop = sessions.some(
            (session) => session.tabId === request.tabId && session.runtime !== "server",
          );
          throw new ServerBrowserPage.ServerBrowserOperationError({
            tag: desktop ? "PreviewAutomationExecutionError" : "PreviewAutomationTabNotFoundError",
            message: desktop
              ? "This tab belongs to the desktop runtime. This environment's server browser cannot control desktop tabs. Omit tabId to open a server tab instead."
              : "The requested server preview tab does not exist.",
          });
        }
        // Reusing another session's tab requires explicit tabId; reading it grants no implicit takeover.
        let existing =
          found && (request.tabIdExplicit || found.control.agentId === request.agentSessionId)
            ? found
            : undefined;
        if (
          existing &&
          open.browserHost !== undefined &&
          (existing.desktop ? "desktop" : "environment") !== open.browserHost
        ) {
          if (request.tabIdExplicit)
            throw new ServerBrowserPage.ServerBrowserOperationError({
              tag: "PreviewAutomationExecutionError",
              message:
                "The selected tab uses a different browser host. Omit tabId to create a new tab; an existing tab cannot switch hosts.",
            });
          existing = undefined;
        }
        if (
          request.tabIdExplicit &&
          (reuse || selectedProfileId !== undefined) &&
          existing === undefined
        ) {
          throw new ServerBrowserPage.ServerBrowserOperationError({
            tag: "PreviewAutomationTabNotFoundError",
            message: "The requested preview tab no longer exists.",
          });
        }
        if (
          selectedProfileId !== undefined &&
          existing &&
          (existing.profileId !== selectedProfileId ||
            existing.desktopHostId !== catalogue?.desktopHostId)
        ) {
          if (request.tabIdExplicit) {
            const detail =
              "The selected tab uses a different browser profile. Existing tabs cannot switch profiles; omit tabId to create a new tab.";
            throw new ServerBrowserPage.ServerBrowserOperationError({
              tag: "PreviewAutomationProfileError",
              message: detail,
              detail: { reason: "tab-mismatch", detail },
            });
          }
          existing = undefined;
        }
        if (!existing && open.browserHost === "desktop" && catalogue === null)
          throw new ServerBrowserPage.ServerBrowserOperationError({
            tag: "PreviewAutomationRemoteUnavailableError",
            message:
              "No unambiguous connected desktop browser is available. The requested desktop tab was not opened.",
          });
        if (
          !existing &&
          newTabProfileId !== undefined &&
          catalogue !== null &&
          !catalogue.supportsNativeRoots
        )
          throw new DesktopBrowserTransportError({ reason: "root-unsupported" });
        const destination =
          initialUrl === undefined
            ? undefined
            : await browserNavigationUrl(
                existing ?? {
                  threadId: request.threadId,
                  desktopHostId:
                    newTabProfileId === undefined ? undefined : catalogue?.desktopHostId,
                },
                initialUrl,
                signal,
              );
        const url = destination?.url;
        signal.throwIfAborted();
        const navigationTimeout = Math.min(remainingTimeoutMs(), NAVIGATION_TIMEOUT_MS);
        if (!existing) closeIdleHeadlessTabs();
        const tab =
          existing ??
          (await runPromise(
            openTab(
              {
                threadId: request.threadId,
                ...(url && !destination?.managed ? { url } : {}),
                ...(reportedProfileId === undefined ? {} : { profileId: reportedProfileId }),
                runtime: "server",
                reveal: false,
                automationOwner: request.agentSessionId,
                ...(environmentHosted
                  ? {
                      environmentHosted: true,
                      beforePublish: (snapshot) => {
                        environmentProfileSessions.add(tabKey(snapshot.threadId, snapshot.tabId));
                      },
                    }
                  : {}),
                ...(desktopHostId === undefined ? {} : { desktopHostId }),
                createDesktopRoot: (snapshot) => createDesktopRoot(snapshot, signal),
                ...(newTabProfileId === undefined || catalogue === null
                  ? {}
                  : { profileId: newTabProfileId, desktopHostId: catalogue.desktopHostId }),
              },
              signal,
            ),
          ));
        signal.throwIfAborted();
        if (existing?.dialog)
          throw new BrowserControlInterrupted({
            message:
              "A browser dialog is pending. Read preview_status and use preview_dialog first.",
            reason: "dialogPending",
          });
        return tab.control.agent(
          request.agentSessionId!,
          () =>
            withNativeSurface(tab, signal, remainingTimeoutMs, async () => {
              if (tab.dialog)
                throw new BrowserControlInterrupted({
                  message:
                    "A browser dialog is pending. Read preview_status and use preview_dialog first.",
                  reason: "dialogPending",
                });
              if (environmentHosted)
                environmentProfileSessions.add(tabKey(tab.threadId, tab.tabId));
              const reveal = open.open ?? open.show;
              if (reveal !== false) {
                tab.revealRequested = true;
                await runPromise(
                  manager.requestReveal({
                    threadId: tab.threadId,
                    tabId: tab.tabId,
                    force: reveal === true,
                  }),
                );
              }
              try {
                if (destination)
                  await prepareBrowserCredential(tab, destination, signal, remainingTimeoutMs());
                signal.throwIfAborted();
                if (existing || destination?.managed) {
                  if (destination)
                    await navigate(
                      tab,
                      destination,
                      "load",
                      Math.min(navigationTimeout, remainingTimeoutMs()),
                      signal,
                    );
                } else {
                  await Promise.resolve(tab.initialNavigation)
                    .then(async () => {
                      if (url) {
                        await tab.page
                          .waitForLoadState("load", {
                            timeout: Math.min(navigationTimeout, remainingTimeoutMs()),
                          })
                          .catch(constVoid);
                      }
                      assertNavigationSucceeded(tab);
                    })
                    .catch(async (cause: unknown) => {
                      // Native roots retain failed destinations; downloads keep their owning tab.
                      if (
                        tab.backingPage === "desktop-root" ||
                        (cause instanceof Error && cause.message.includes("Download is starting"))
                      )
                        throw cause;
                      await runPromise(manager.close({ threadId: tab.threadId, tabId: tab.tabId }));
                      dropTab(tab, false);
                      throw cause;
                    });
                  signal.throwIfAborted();
                }
                if (destination) rememberHostedRun(tab, destination);
                if (!existing && destination?.managed && url) {
                  await tab.page
                    .waitForLoadState("load", {
                      timeout: Math.min(navigationTimeout, remainingTimeoutMs()),
                    })
                    .catch(constVoid);
                }
              } finally {
                // Creation can finish before native acceptance and session publication.
                // Keep that terminal failure even when awaiting the original navigation rejects.
                if (!existing && tab.backingPage === "desktop-root") {
                  if (tab.latestNavigationStatus._tag === "LoadFailed")
                    await report(tab, tab.latestNavigationStatus);
                  else await reportLoaded(tab, true);
                }
              }
              if (reveal === true && tab.viewers.size === 0 && tab.desktop === null)
                await awaitViewer(
                  tab,
                  Math.min(REVEAL_VIEWER_WAIT_MS, deadlineMs - performance.now()),
                );
              return statusWithTitle(tab, request.agentSessionId);
            }),
          signal,
          deadlineMs,
        );
      }
      case "recordingStop": {
        if (
          !request.tabIdExplicit &&
          [...tabs.values()].filter(
            (candidate) =>
              candidate.threadId === request.threadId &&
              candidate.control.agentId === request.agentSessionId,
          ).length > 1
        )
          throw new BrowserControlInterrupted({
            message:
              "Multiple tabs belong to this agent session. Pass a tabId from preview_open or preview_status tabs.",
            reason: "tabRequired",
          });
        const recordings = [...tabs.values()].filter(
          (candidate) =>
            candidate.threadId === request.threadId &&
            candidate.control.agentMayAct(request.agentSessionId ?? "") &&
            (candidate.recording || candidate.recordingStart),
        );
        const targetTabId =
          request.tabId ?? latestThreadTab(request.threadId, request.agentSessionId)?.tabId;
        const tab =
          recordings.find((candidate) => candidate.tabId === targetTabId) ??
          (!request.tabIdExplicit && recordings.length === 1 ? recordings[0] : undefined);
        if (!tab) {
          throw new ServerBrowserPage.ServerBrowserOperationError({
            tag: "PreviewAutomationRecordingNotActiveError",
            message: "No recording is active for this thread.",
          });
        }
        // Stopping must still drain a recording after its caller's deadline expires.
        return tab.control.agent(request.agentSessionId ?? "", () => {
          const stopSignal = signal.aborted ? new AbortController().signal : signal;
          const stopTimeoutMs = signal.aborted ? () => 10_000 : remainingTimeoutMs;
          return withNativeSurface(tab, stopSignal, stopTimeoutMs, (_viewport, releaseSurface) =>
            stopRecording(tab, stopSignal, stopTimeoutMs, releaseSurface),
          );
        });
      }
    }
    if (request.operation === "close" && request.tabId !== undefined) {
      const key = tabKey(request.threadId, request.tabId);
      const root = nativeRoots.get(key);
      if (
        root?.published &&
        !tabs.has(key) &&
        !(await runPromise(desktopChannel.isAttached(root.key)))
      ) {
        if (root.automationOwner !== request.agentSessionId)
          throw new BrowserControlInterrupted({
            message: "Only the agent session that opened this tab can close it.",
            reason: "agentMismatch",
          });
        await runPromise(manager.close({ threadId: request.threadId, tabId: request.tabId }));
        return {};
      }
      if (!tabs.has(key)) {
        const { sessions } = await runPromise(manager.list({ threadId: request.threadId }));
        const retained = sessions.find(
          (snapshot) =>
            snapshot.tabId === request.tabId &&
            snapshot.runtime === "server" &&
            (snapshot.backingPage === "server" ||
              (snapshot.backingPage === "desktop-root" && snapshot.desktopRootId === undefined)),
        );
        if (retained && !tabs.has(key)) {
          if (retained.automationOwner === undefined)
            throw new BrowserControlInterrupted({
              message:
                "This tab has no agent owner. Ask the user to close it in the browser panel.",
              reason: "unclaimedTab",
            });
          if (
            request.agentSessionId === undefined ||
            retained.automationOwner !== request.agentSessionId
          )
            throw new BrowserControlInterrupted({
              message: "Only the agent session that opened this tab can close it.",
              reason: "agentMismatch",
            });
          await runPromise(manager.close({ threadId: request.threadId, tabId: request.tabId }));
          return {};
        }
      }
    }
    const tab = await requireTab(request, signal);
    signal.throwIfAborted();
    // Closing must unblock an action waiting on a dialog, without queueing behind it.
    if (request.operation === "close") {
      if (tab.control.agentId === null)
        throw new BrowserControlInterrupted({
          message: "This tab has no agent owner. Ask the user to close it in the browser panel.",
          reason: "unclaimedTab",
        });
      if (tab.control.controller !== null)
        throw new BrowserControlInterrupted({
          message: "A human controls this tab.",
          reason: "humanControl",
        });
      // Native windows keep their close veto; embedded tabs finish unloading before removal.
      if (
        tab.desktop &&
        tab.backingPage !== "desktop-root" &&
        !nativePopupForTab(tab.threadId, tab.tabId) &&
        tab.dialog === null
      ) {
        void tab.control.close().catch(constVoid);
        tab.closing = true;
        await unloadDesktopPage(tab.page);
      }
      await runPromise(manager.close({ threadId: tab.threadId, tabId: tab.tabId }));
      void tab.control.close().catch(constVoid);
      dropTab(tab, false);
      return {};
    }
    // Resolve dialogs outside the queue, with ownership checked, to unblock waiting clicks.
    if (request.operation === "dialog") {
      if (tab.control.controller !== null)
        throw new BrowserControlInterrupted({
          message: "A human controls this tab.",
          reason: "humanControl",
        });
      await resolveDialog(tab, input as PreviewAutomationDialogInput);
      return statusWithTitle(tab, request.agentSessionId);
    }
    const agentSessionId = request.agentSessionId!;

    if (
      READ_OPERATIONS.has(request.operation) &&
      tab.control.agentId !== agentSessionId &&
      !tab.control.agentCanActNow(agentSessionId)
    ) {
      return tab.control.observe(async () => {
        if (tab.dialog)
          throw new BrowserControlInterrupted({
            message: "A browser dialog is pending. Read preview_status.",
            reason: "dialogPending",
          });
        return withNativeSurface(tab, signal, remainingTimeoutMs, (_viewport, releaseSurface) =>
          executeTabOperation(tab, request, signal, remainingTimeoutMs, releaseSurface),
        );
      });
    }
    // Reject agent typing here: the desktop CDP relay also carries human viewer input.
    if (
      tab.desktop &&
      (tab.backingPage === "desktop" || tab.backingPage === undefined) &&
      (request.operation === "type" || request.operation === "press")
    )
      throw new ServerBrowserPage.ServerBrowserOperationError({
        tag: "PreviewAutomationExecutionError",
        message:
          "Keyboard automation is unavailable for this shared desktop page. Create a new automation tab with preview_open({reuseExistingTab:false}) and retain its returned tabId for subsequent actions.",
      });
    return tab.control.agent(
      agentSessionId,
      () =>
        withNativeSurface(tab, signal, remainingTimeoutMs, async (_viewport, releaseSurface) => {
          if (tab.dialog)
            throw new BrowserControlInterrupted({
              message:
                "A browser dialog is pending. Read preview_status and use preview_dialog first.",
              reason: "dialogPending",
            });
          const generation = tab.control.generation;
          tab.agentOperating = !READ_OPERATIONS.has(request.operation);
          updateFileChooserInterception(tab);
          try {
            return await executeTabOperation(
              tab,
              request,
              signal,
              remainingTimeoutMs,
              releaseSurface,
            );
          } finally {
            tab.agentOperating = false;
            updateFileChooserInterception(tab);
            if (generation !== tab.control.generation) ServerBrowserPage.invalidateRefs(tab.page);
          }
        }),
      signal,
      deadlineMs,
    );
  };

  const desktopKey = (tab: ServerTab) => ({
    threadId: tab.threadId,
    tabId: tab.tabId,
    ...(tab.desktopHostId === undefined ? {} : { desktopHostId: tab.desktopHostId }),
  });

  /** Native layout and captures need a paintable page even when no thread shows it. */
  const withNativeSurface = async <A>(
    tab: ServerTab,
    signal: AbortSignal,
    remainingTimeoutMs: () => number,
    operation: (
      viewport?: { readonly width: number; readonly height: number } | null,
      releaseSurface?: () => Promise<void>,
    ) => Promise<A>,
    viewport?: PreviewViewportSetting,
    rendering?: Pick<
      Parameters<DesktopBrowserChannel.DesktopBrowserChannel["Service"]["surface"]>[1],
      "viewportSize" | "zoomFactor"
    >,
  ): Promise<A> => {
    signal.throwIfAborted();
    if (!tab.desktop) {
      const release = await acquirePageActivity(tab);
      try {
        return await operation();
      } finally {
        await release();
      }
    }
    const releaseActivity = await acquirePageActivity(tab);
    const key = desktopKey(tab);
    const leaseId = NodeCrypto.randomUUID();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await runPromise(
        desktopChannel
          .surface(key, { action: "release", leaseId }, Math.min(500, remainingTimeoutMs()))
          .pipe(Effect.ignore),
      );
      await releaseActivity();
    };
    try {
      const appliedViewport = await runPromise(
        desktopChannel.surface(
          key,
          {
            action: "acquire",
            leaseId,
            timeoutMs: Math.max(
              1,
              Math.floor(remainingTimeoutMs() - Math.min(150, remainingTimeoutMs() / 10)),
            ),
            ...(viewport === undefined ? {} : { viewport }),
            ...rendering,
          },
          Math.min(2_500, remainingTimeoutMs()),
        ),
        { signal },
      );
      signal.throwIfAborted();
      return await operation(appliedViewport, release);
    } finally {
      await release();
    }
  };

  /** Screencasts keep painting between individual automation requests. */
  const acquirePersistentNativeSurface = async (
    tab: ServerTab,
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
      readonly commandTimeoutMs?: number;
    } = {},
  ): Promise<() => Promise<void>> => {
    options.signal?.throwIfAborted();
    if (!tab.desktop) return acquirePageActivity(tab);
    const releaseActivity = await acquirePageActivity(tab);
    const key = desktopKey(tab);
    const leaseId = NodeCrypto.randomUUID();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await runPromise(
        desktopChannel
          .surface(key, { action: "release", leaseId }, Math.min(100, options.timeoutMs ?? 100))
          .pipe(Effect.ignore),
      );
      await releaseActivity();
    };
    try {
      await runPromise(
        desktopChannel.surface(
          key,
          {
            action: "acquire",
            leaseId,
            ...(options.commandTimeoutMs === undefined
              ? {}
              : { timeoutMs: options.commandTimeoutMs }),
          },
          Math.min(2_500, options.timeoutMs ?? 2_500),
        ),
        { signal: options.signal },
      );
      options.signal?.throwIfAborted();
      return release;
    } catch (cause) {
      await release();
      throw cause;
    }
  };

  /** Stop or resume streams without letting cleanup pin a request queue. */
  const withNativeCleanup = async (tab: ServerTab, operation: () => Promise<unknown>) => {
    let active = true;
    let release = async () => {};
    try {
      await ServerBrowserPage.withReadBudget({ timeoutMs: 500 }, async (read) => {
        await read("cleanup surface", async () => {
          const acquired = await acquirePersistentNativeSurface(tab, {
            timeoutMs: 200,
            commandTimeoutMs: 450,
          });
          if (!active) {
            await acquired();
            return;
          }
          release = acquired;
        }).catch(constVoid);
        await read("screencast cleanup", operation);
      });
    } catch {
      /* Cleanup is best effort; the native deadline still retires every command. */
    } finally {
      active = false;
      await release();
    }
  };

  const executeTabOperation = async (
    tab: ServerTab,
    request: PreviewAutomationRequest,
    signal: AbortSignal,
    remainingTimeoutMs: () => number,
    releaseRequestSurface?: () => Promise<void>,
  ) => {
    const originalInput = request.input as {
      readonly timeoutMs?: number;
      readonly [key: string]: unknown;
    };
    const input: unknown = {
      ...originalInput,
      timeoutMs: Math.max(1, Math.min(originalInput.timeoutMs ?? 10_000, remainingTimeoutMs())),
    };
    switch (request.operation) {
      case "navigate": {
        const navigateInput = input as PreviewAutomationNavigateInput;
        await recordAction(tab, "navigate", async () => {
          const destination = await browserNavigationUrl(
            tab,
            resolveNavigationUrl(navigateInput),
            signal,
          );
          await prepareBrowserCredential(tab, destination, signal, remainingTimeoutMs());
          signal.throwIfAborted();
          await navigate(
            tab,
            destination,
            navigateInput.readiness ?? "load",
            Math.min(originalInput.timeoutMs ?? request.timeoutMs, remainingTimeoutMs()),
            signal,
            () => rememberHostedRun(tab, destination),
          );
        });
        return statusWithTitle(tab, request.agentSessionId);
      }
      case "resize": {
        const setting = resolvePreviewViewport(input as PreviewAutomationResizeInput);
        const from = fixedViewportSize(tab.setting);
        const to = fixedViewportSize(setting);
        const drawn = tab.desktopResize.promise;
        await runPromise(
          manager.resize({ threadId: tab.threadId, tabId: tab.tabId, viewport: setting }),
        );
        await applySetting(tab, setting);
        if (tab.backingPage === "desktop-root") {
          return {
            tabId: tab.tabId,
            setting,
            viewport: await ServerBrowserPage.viewportSize(tab.page, tab.cdp),
          };
        }
        if (!tab.desktop) {
          return {
            tabId: tab.tabId,
            setting,
            viewport: tab.page.viewportSize() ?? UNATTACHED_FILL_VIEWPORT,
          };
        }
        return withNativeSurface(
          tab,
          signal,
          remainingTimeoutMs,
          async () => {
            const changed = from?.width !== to?.width || from?.height !== to?.height;
            const remainingMs = remainingTimeoutMs;
            const within = <A>(promise: Promise<A>, ms: number) =>
              runPromise(
                Effect.promise(() => promise).pipe(
                  Effect.timeoutOption(ms),
                  Effect.map(Option.getOrNull),
                ),
              );
            // The desktop draws the new size after the session update; its page resize says it has.
            // Half the time left keeps room for the read, which runs even if nothing was drawn,
            // because a page can keep another size than the one asked for.
            if (changed) await within(drawn, Math.min(DESKTOP_RESIZE_WAIT_MS, remainingMs() / 2));
            const changes = tab.desktopViewportChanges;
            const measured = await within(measureDesktopViewport(tab), remainingMs());
            // Only a read after the draw, with no page resize or load during it, measures this resize.
            return {
              tabId: tab.tabId,
              setting,
              ...(measured && tab.desktopViewportChanges === changes ? { viewport: measured } : {}),
            };
          },
          setting,
        );
      }
      case "setColorScheme": {
        const { colorScheme } = input as PreviewAutomationSetColorSchemeInput;
        const snapshot = await runPromise(
          manager.adjust({ threadId: tab.threadId, tabId: tab.tabId, colorScheme }),
        );
        await applyRendering(tab, snapshot);
        return { tabId: tab.tabId, colorScheme };
      }
      case "snapshot": {
        const includeImage = (input as { readonly includeImage?: boolean }).includeImage !== false;
        const capture = async () => {
          return ServerBrowserPage.snapshot({
            ...tab,
            renderScale: tab.desktop ? "display" : RENDER_SCALE,
            fullScreenshot: (input as PreviewAutomationSnapshotInput | undefined)?.fullScreenshot,
            includeImage,
            signal,
            timeoutMs: remainingTimeoutMs(),
          });
        };
        const snapshot = await (includeImage
          ? withScreencastsPaused(tab, capture, signal, remainingTimeoutMs, releaseRequestSurface)
          : capture());
        const loadError = loadErrorOf(tab);
        return loadError ? { ...snapshot, url: loadError.url, loadError } : snapshot;
      }
      case "click": {
        // Time spent queued behind other work on this tab counts against the broker's deadline.
        const clickInput = {
          ...(input as PreviewAutomationClickInput),
          timeoutMs: Math.max(
            1,
            Math.floor(
              Math.min(
                (input as PreviewAutomationClickInput).timeoutMs ?? request.timeoutMs,
                remainingTimeoutMs(),
              ),
            ),
          ),
        };
        await recordAction(tab, "click", () =>
          ServerBrowserPage.click(tab.page, clickInput, pointerFor(tab), signal),
        );
        return undefined;
      }
      case "hover":
        return recordAction(tab, "hover", () =>
          ServerBrowserPage.hover(
            tab.page,
            input as PreviewAutomationHoverInput,
            pointerFor(tab),
            signal,
          ),
        );
      case "select":
        return recordAction(tab, "select", () =>
          ServerBrowserPage.select(tab.page, input as PreviewAutomationSelectInput, signal),
        );
      case "drag":
        return recordAction(tab, "drag", () =>
          ServerBrowserPage.drag(
            tab.page,
            input as PreviewAutomationDragInput,
            pointerFor(tab),
            signal,
          ),
        );
      case "upload":
        return recordAction(tab, "upload", () =>
          uploadFiles(tab, input as PreviewAutomationUploadInput, signal),
        );
      case "type":
        return recordAction(tab, "type", () =>
          ServerBrowserPage.type(tab.page, input as PreviewAutomationTypeInput, signal),
        );
      case "press":
        return recordAction(tab, "press", () =>
          ServerBrowserPage.press(tab.page, input as PreviewAutomationPressInput, signal),
        );
      case "scroll":
        return recordAction(tab, "scroll", () =>
          ServerBrowserPage.scroll(tab.page, input as PreviewAutomationScrollInput, signal),
        );
      case "evaluate":
        return ServerBrowserPage.evaluate(tab.cdp, input as PreviewAutomationEvaluateInput, {
          signal,
          timeoutMs: remainingTimeoutMs(),
        });
      case "waitFor":
        return ServerBrowserPage.waitFor(tab.page, input as PreviewAutomationWaitForInput, {
          signal,
          timeoutMs: remainingTimeoutMs(),
        });
      case "recordingStart": {
        const recording = await startRecording(
          tab,
          signal,
          remainingTimeoutMs,
          releaseRequestSurface,
        );
        return { tabId: tab.tabId, recording: true, startedAt: recording.startedAt };
      }
    }
  };

  const runOperation = (...args: Parameters<typeof runOperationUnprotected>) => {
    const [request] = args;
    const url =
      request.operation === "navigate"
        ? resolveNavigationUrl(request.input as PreviewAutomationNavigateInput)
        : request.operation === "open" || request.operation === "openWithProfile"
          ? (request.input as PreviewAutomationOpenInput).url
          : undefined;
    if (url === undefined) return runOperationUnprotected(...args);
    const tab =
      request.tabId === undefined
        ? latestThreadTab(request.threadId, request.agentSessionId)
        : tabs.get(tabKey(request.threadId, request.tabId));
    return withHostedDestination(
      tab ?? { threadId: request.threadId },
      normalizePreviewUrl(url),
      () => runOperationUnprotected(...args),
    );
  };

  const handleRequest = (connectionId: string, request: PreviewAutomationRequest) =>
    Clock.clockWith((clock) => {
      const timeoutMs = Math.max(1, request.timeoutMs - Math.min(500, request.timeoutMs / 10));
      const started = clock.monotonicTimeNanosUnsafe();
      const deadlineMs = performance.now() + request.timeoutMs;
      const remainingTimeoutMs = () =>
        Math.max(1, timeoutMs - Number(clock.monotonicTimeNanosUnsafe() - started) / 1_000_000);
      return Effect.tryPromise({
        try: (signal) =>
          runOperation(request, signal, remainingTimeoutMs, deadlineMs).finally(() =>
            markUsed(request),
          ),
        catch: (cause) =>
          isDesktopBrowserTransportError(cause)
            ? new ServerBrowserPage.ServerBrowserOperationError({
                tag: "PreviewAutomationRemoteUnavailableError",
                message: cause.message,
                detail: { reason: cause.reason },
              })
            : isPreviewNativeCreateError(cause)
              ? new ServerBrowserPage.ServerBrowserOperationError({
                  tag: "PreviewAutomationRemoteUnavailableError",
                  message: cause.message,
                })
              : ServerBrowserPage.toOperationError(cause),
      }).pipe(
        Effect.timeout(timeoutMs),
        Effect.catchTags({
          TimeoutError: () =>
            Effect.fail(
              new ServerBrowserPage.ServerBrowserOperationError({
                tag: "PreviewAutomationTimeoutError",
                message: "The browser operation exceeded its execution deadline.",
              }),
            ),
        }),
        Effect.match({
          onSuccess: (result) => ({ ok: true as const, result }),
          onFailure: (error) => ({
            ok: false as const,
            error: {
              _tag: error.tag,
              message: error.message,
              ...(error.detail === undefined ? {} : { detail: error.detail }),
            },
          }),
        }),
        Effect.flatMap((outcome) =>
          broker.respond({
            clientId: SERVER_HOST_CLIENT_ID,
            connectionId,
            requestId: request.requestId,
            ...outcome,
          }),
        ),
        Effect.ignore,
      );
    });

  const mirrorManagerEvent = (event: PreviewEvent) =>
    Effect.promise(async () => {
      if (event.type === "closed") {
        await runPromise(
          hosting.setActivity({
            activityId: `server-browser-presentation:${tabKey(event.threadId, event.tabId)}`,
            threadId: event.threadId,
            url: "about:blank",
            active: false,
          }),
        );
      } else if ("snapshot" in event) {
        await runPromise(
          syncNativeHostingPresentation({
            threadId: event.threadId,
            tabId: event.tabId,
            desktopHostId: event.snapshot.desktopHostId,
          }),
        );
      }
      if (event.type === "opened" && event.snapshot.runtime === "server") {
        const key = tabKey(event.snapshot.threadId, event.snapshot.tabId);
        if (event.snapshot.automationOwner === undefined || pendingTabs.has(key) || tabs.has(key))
          await ensureTab(event.snapshot, true).catch(async (cause: unknown) => {
            if (!isBrowserControlInterrupted(cause) || cause.reason !== "tabLimit") return;
            await runPromise(
              manager
                .reportStatus({
                  threadId: ThreadId.make(event.threadId),
                  tabId: event.tabId,
                  serverControlled: true,
                  navStatus: {
                    _tag: "LoadFailed",
                    url:
                      event.snapshot.navStatus._tag === "Idle"
                        ? "about:blank"
                        : event.snapshot.navStatus.url,
                    title: "",
                    code: -12,
                    description: cause.message,
                  },
                  canGoBack: false,
                  canGoForward: false,
                })
                .pipe(Effect.ignore),
            );
          });
        return;
      }
      const key = tabKey(event.threadId, event.tabId);
      const tab = tabs.get(key);
      if (event.type === "closed") {
        sessionHostedOrigins.delete(key);
        environmentProfileSessions.delete(key);
        const popup = nativePopupForTab(event.threadId, event.tabId);
        if (popup) {
          popup.closeRequested = true;
        }
        const root = nativeRoots.get(key);
        if (root) root.closeRequested = true;
      }
      if (event.type === "closed" && !tab && pendingTabs.has(key)) closedPendingTabs.add(key);
      if (!tab) return;
      if (event.type === "closed") {
        closedSessions.add(key);
        dropTab(tab, false);
        closedSessions.delete(key);
        return;
      }
      if (event.type === "resized") {
        if (
          !event.request &&
          viewportSettingsEqual(event.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT, tab.setting) &&
          (event.snapshot.colorScheme ?? "system") === tab.colorScheme &&
          (event.snapshot.zoomFactor ?? 1) === tab.zoomFactor
        )
          return;
        // Desktop tabs only record the setting, so status need not wait behind an agent action.
        if (tab.desktop && tab.backingPage !== "desktop-root")
          tab.setting = event.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT;
        await tab.control
          .system(() =>
            withNativeSurface(
              tab,
              new AbortController().signal,
              () => NAVIGATION_TIMEOUT_MS,
              async () => {
                if (
                  !viewportSettingsEqual(
                    event.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
                    tab.setting,
                  )
                ) {
                  await applySetting(tab, event.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT);
                }
                await applyRendering(tab, event.snapshot);
                const request = event.request;
                if (request?.clear === "cookies") await tab.cdp.send("Network.clearBrowserCookies");
                if (request?.clear === "cache") await tab.cdp.send("Network.clearBrowserCache");
                if (request?.hardReload) {
                  tab.pendingInitialRequestUrl = null;
                  await leaveBusyPage(tab, tab.cdp);
                  const url = tab.page.url();
                  const destination = await prepareExistingBrowserNavigation(tab, url);
                  await ServerBrowserPage.navigateWithRedirect(
                    tab.page,
                    url,
                    destination.url,
                    async (redirected) => {
                      // Routing disables HTTP cache; Playwright also waits for the redirected commit.
                      if (redirected)
                        await tab.page.reload({ ...VIEWER_NAVIGATION_OPTIONS, waitUntil: "load" });
                      else await tab.cdp.send("Page.reload", { ignoreCache: true });
                    },
                  );
                  rememberHostedRun(tab, destination);
                }
              },
            ),
          )
          .catch((cause: unknown) =>
            runFork(Effect.logWarning("server preview could not apply a tab setting", { cause })),
          );
      }
    });

  const viewerInputParams = <const P extends object>(tab: ServerTab, params: P): P =>
    tab.desktop ? { ...params, [DESKTOP_BROWSER_INPUT_SOURCE_PARAM]: "viewer" } : params;

  const releaseViewerInput = async (tab: ServerTab, viewer: ViewerState, session: CDPSession) => {
    for (const { key, code } of viewer.pressedKeys.values()) {
      await session
        .send("Input.dispatchKeyEvent", viewerInputParams(tab, { type: "keyUp", key, code }))
        .catch(constVoid);
    }
    viewer.pressedKeys.clear();
    for (const [button, point] of viewer.pressedButtons) {
      await session
        .send(
          "Input.dispatchMouseEvent",
          viewerInputParams(tab, {
            type: "mouseReleased",
            button,
            ...point,
            buttons: 0,
            clickCount: 1,
          }),
        )
        .catch(constVoid);
    }
    viewer.pressedButtons.clear();
  };

  const dispatchViewerInput = async (
    tab: ServerTab,
    session: CDPSession,
    viewer: ViewerState,
    raw: unknown,
  ) => {
    const message = asRecord(raw);
    if (!message) return;
    const modifiers = modifiersOf(message);
    switch (message.type) {
      case "mouse": {
        const action = message.action;
        const type =
          action === "down" ? "mousePressed" : action === "up" ? "mouseReleased" : "mouseMoved";
        const button = ["none", "left", "middle", "right"].includes(String(message.button))
          ? (message.button as "none" | "left" | "middle" | "right")
          : "none";
        await session.send(
          "Input.dispatchMouseEvent",
          viewerInputParams(tab, {
            type,
            x: num(message.x),
            y: num(message.y),
            button,
            buttons: num(message.buttons),
            clickCount: num(message.clickCount, type === "mouseMoved" ? 0 : 1),
            modifiers,
          }),
        );
        if (button !== "none") {
          if (action === "down")
            viewer.pressedButtons.set(button, { x: num(message.x), y: num(message.y) });
          else if (action === "up") viewer.pressedButtons.delete(button);
        }
        return;
      }
      case "wheel":
        viewer.scrolledAt = Date.now();
        await session.send(
          "Input.dispatchMouseEvent",
          viewerInputParams(tab, {
            type: "mouseWheel",
            x: num(message.x),
            y: num(message.y),
            deltaX: num(message.deltaX),
            deltaY: num(message.deltaY),
            modifiers,
          }),
        );
        return;
      case "key": {
        const key = typeof message.key === "string" ? message.key : "";
        const code = typeof message.code === "string" ? message.code : "";
        const text = typeof message.text === "string" ? message.text : undefined;
        if (message.action === "up") {
          await session.send(
            "Input.dispatchKeyEvent",
            viewerInputParams(tab, { type: "keyUp", key, code, modifiers }),
          );
          viewer.pressedKeys.delete(code || key);
          return;
        }
        const command = editingCommand(key, modifiers);
        const copying =
          !tab.desktop && (command?.commands[0] === "copy" || command?.commands[0] === "cut");

        // Copy keys get disjoint millisecond windows so each frame's copy belongs to one key.
        if (copying)
          while (Date.now() <= tab.copyKeyedUntil) await sleepUntil(tab.copyKeyedUntil + 1);
        const since = Date.now();
        await session.send(
          "Input.dispatchKeyEvent",
          viewerInputParams(tab, {
            type: text ? "keyDown" : "rawKeyDown",
            key,
            code,
            modifiers,
            ...(text ? { text, unmodifiedText: text } : {}),
            ...command,
            windowsVirtualKeyCode: num(
              message.keyCode,
              key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
            ),
          }),
        );
        viewer.pressedKeys.set(code || key, { key, code });
        if (!copying) return;
        const until = Date.now();
        tab.copyKeyedUntil = until;
        // A busy frame answers late; its read must not hold later input.
        const read = tab.copyReads.then(async () => {
          const copied = await takeCopiedText(tab, since, until);
          if (copied) viewer.push({ _tag: "clipboard", text: copied });
        });
        tab.copyReads = read;
        return () => read;
      }
      case "text":
        if (typeof message.text === "string" && message.text.length > 0) {
          await session.send(
            "Input.insertText",
            viewerInputParams(tab, { text: message.text.slice(0, 10_000) }),
          );
        }
        return;
      case "resize": {
        const width = Math.min(Math.round(num(message.width)), 3840);
        const height = Math.min(Math.round(num(message.height)), 2160);
        if (width < 100 || height < 100) return;
        viewer.requestedSize = { width, height, order: ++viewerResizeOrder };
        if (tab.setting._tag !== "fill" || (tab.desktop && tab.backingPage !== "desktop-root"))
          return;
        if (tab.backingPage === "desktop-root") {
          await applySetting(tab, tab.setting);
          return;
        }
        const current = tab.page.viewportSize();
        if (current?.width === width && current.height === height) return;
        await tab.page.setViewportSize({ width, height });
        await broadcastViewport(tab);
        return;
      }
      case "viewport": {
        const setting = decodeViewportSetting(message.setting);
        await runPromise(
          manager.resize({ threadId: tab.threadId, tabId: tab.tabId, viewport: setting }),
        );
        await applySetting(tab, setting);
        return;
      }
      // A stalled navigation must not block a corrected URL or further viewer input; only the
      // bounded wait for a page script that never yields comes first.
      case "navigate":
        if (typeof message.url === "string") {
          tab.pendingInitialRequestUrl = null;
          const url = normalizePreviewUrl(message.url);
          startViewerNavigation(
            tab,
            async (signal) => {
              const destination = await browserNavigationUrl(tab, url, signal);
              await prepareBrowserCredential(tab, destination, signal);
              signal.throwIfAborted();
              await leaveBusyPage(tab, session);
              signal.throwIfAborted();
              await tab.page.goto(destination.url, VIEWER_NAVIGATION_OPTIONS);
              rememberHostedRun(tab, destination);
            },
            url,
          );
        }
        return;
      case "history":
        tab.pendingInitialRequestUrl = null;
        startViewerNavigation(tab, async (signal) => {
          const delta = num(message.delta) < 0 ? -1 : 1;
          const history = await session.send("Page.getNavigationHistory");
          const url = history.entries[history.currentIndex + delta]?.url;
          const navigate = async () => {
            await leaveBusyPage(tab, session);
            signal.throwIfAborted();
            if (delta < 0) await tab.page.goBack(VIEWER_NAVIGATION_OPTIONS);
            else await tab.page.goForward(VIEWER_NAVIGATION_OPTIONS);
          };
          if (typeof url !== "string") await navigate();
          else {
            await withHostedDestination(tab, url, async () => {
              const destination = await prepareExistingBrowserNavigation(tab, url, signal);
              await ServerBrowserPage.navigateWithRedirect(
                tab.page,
                url,
                destination.url,
                navigate,
                signal,
              );
              rememberHostedRun(tab, destination);
            });
          }
        });
        return;
      case "stopLoading": {
        const generation = tab.navigationGeneration;
        tab.stoppedGeneration = generation;
        await session.send("Page.stopLoading");
        // Stopping a committed document need not emit Playwright's load or requestfailed events.
        settleStoppedNavigation(tab, generation);
        return;
      }
      case "reload":
        tab.pendingInitialRequestUrl = null;
        startViewerNavigation(tab, async (signal) => {
          const url = tab.crashedUrl ?? tab.crash?.url ?? tab.page.url();
          const destination = await prepareExistingBrowserNavigation(tab, url, signal);
          await ServerBrowserPage.navigateWithRedirect(
            tab.page,
            url,
            destination.url,
            async (redirected) => {
              await leaveBusyPage(tab, session);
              signal.throwIfAborted();
              if (tab.crash) {
                await tab.page.goto(destination.url, VIEWER_NAVIGATION_OPTIONS);
                return;
              }
              // A redirect route disables HTTP cache and must remain through the navigation commit.
              if (message.ignoreCache === true && !redirected)
                await session.send("Page.reload", { ignoreCache: true });
              else
                await tab.page.reload({
                  ...VIEWER_NAVIGATION_OPTIONS,
                  ...(message.ignoreCache === true ? { waitUntil: "load" as const } : {}),
                });
            },
            signal,
          );
          rememberHostedRun(tab, destination);
        });
        return;
      case "probe": {
        const x = num(message.x);
        const y = num(message.y);
        const result = await session.send("Runtime.evaluate", {
          expression: `(${EDITABLE_AT_POINT_SCRIPT})(${x}, ${y})`,
          returnByValue: true,
        });
        viewer.push({ _tag: "probe", x, y, editable: result.result.value === true });
        return;
      }
    }
  };

  const attachViewer: ServerBrowser["Service"]["attachViewer"] = Effect.fn(
    "ServerBrowser.attachViewer",
  )(function* (input) {
    const warm = tabs.has(tabKey(input.threadId, input.tabId));
    const tab = yield* findTab(input.threadId, input.tabId);
    yield* Effect.tryPromise({
      try: () => tab.navigationReady,
      catch: (cause) => new ServerBrowserLaunchError({ cause }),
    });
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => acquirePersistentNativeSurface(tab),
        catch: (cause) => new ServerBrowserLaunchError({ cause }),
      }),
      (release) => Effect.promise(release),
    );
    yield* Effect.tryPromise({
      try: async (signal) => {
        const pageUrl = tab.page.url();
        const currentUrl = tab.crashedUrl ?? pageUrl;
        if (!warm && tab.crashedUrl === undefined) return;
        // Embedded guests prepare their own return after the surface lease wakes their renderer.
        if (
          tab.desktop !== null &&
          tab.backingPage !== "desktop-root" &&
          tab.backingPage !== "desktop-popup"
        )
          return;
        const assetUrl = await renewPreviewAssetUrl(tab, currentUrl, 0, signal);
        const parsed = new URL(currentUrl);
        const prepared =
          tab.hostedOrigins.has(parsed.origin) || isLocalLoopbackHost(parsed.hostname)
            ? await prepareRetainedBrowserNavigation(tab, assetUrl, signal, 0)
            : { url: assetUrl, restarted: false, runId: undefined };
        const shouldReload = () => prepared.url !== pageUrl || hostedRunChanged(tab, prepared);
        if (!shouldReload()) {
          rememberHostedRun(tab, prepared);
          return;
        }
        await tab.control.system(async () => {
          if (tab.page.url() !== pageUrl || !shouldReload()) return;
          tab.navigationFailed = false;
          await leaveBusyPage(tab, tab.cdp);
          signal.throwIfAborted();
          if (prepared.url === pageUrl) await tab.page.reload(VIEWER_NAVIGATION_OPTIONS);
          else await tab.page.goto(prepared.url, VIEWER_NAVIGATION_OPTIONS);
          rememberHostedRun(tab, prepared);
          await reportLoaded(tab, true);
        });
      },
      catch: (cause) => new ServerBrowserLaunchError({ cause }),
    });
    const output = yield* Queue.make<ServerBrowserViewerOutput>({
      capacity: VIEWER_OUTPUT_LIMIT,
      strategy: "dropping",
    });
    const session = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => tab.page.context().newCDPSession(tab.page),
        catch: (cause) => new ServerBrowserLaunchError({ cause }),
      }),
      (session) =>
        Effect.promise(() =>
          session
            .send("Page.stopScreencast")
            .catch(constVoid)
            .then(() => session.detach())
            .catch(constVoid),
        ),
    );
    const quality = Math.min(100, Math.max(1, Math.round(input.quality)));
    // Chromium may drop the final frame during a burst; send a still when it settles.
    let framesInFlight = 0;
    let mayHaveDropped = false;
    let motion = false;
    const recentFrames: Array<number> = [];
    let screencastParams = Promise.resolve();
    let screencastScale = 1;
    const startScreencast = (scale: number, timeoutMs = 10_000) => {
      screencastScale = scale;
      const previous = screencastParams;
      const started = ServerBrowserPage.withReadBudget({ timeoutMs }, async (read) => {
        await read("viewer parameters", () => previous);
        if (tab.capturing > 0) return;
        await read("viewer screencast stop", () => session.send("Page.stopScreencast"));
        await read("viewer screencast start", () =>
          session.send("Page.startScreencast", {
            format: "jpeg",
            quality: screencastScale < 1 ? Math.min(quality, SCREENCAST_MOTION_QUALITY) : quality,
            maxWidth: Math.max(1, Math.round(input.maxWidth * screencastScale)),
            maxHeight: Math.max(1, Math.round(input.maxHeight * screencastScale)),
          }),
        );
      });
      screencastParams = started.then(constVoid, constVoid);
      return screencastParams;
    };
    const viewer: ViewerState = {
      id: NodeCrypto.randomUUID(),
      canOperate: input.canOperate,
      pressedKeys: new Map(),
      pressedButtons: new Map(),
      push: (next) => {
        // Dropped frames must still release Chromium.
        if (Queue.offerUnsafe(output, next)) return;
        if (next._tag === "frame") runFork(next.ack);
        // State a stalled viewer cannot miss compacts its backlog. It runs
        // synchronously so an older compaction can never land after a newer one.
        else if (["gone", "reconnect", "control", "viewport", "fileChooser"].includes(next._tag)) {
          const dropped = runSyncExit(Queue.clear(output));
          if (dropped._tag === "Failure") return;
          const items = [...dropped.value, next];
          // Without its latest size and control the viewer cannot map input at all.
          const state = (["control", "viewport"] as const).flatMap(
            (tag) => items.findLast((item) => item._tag === tag) ?? [],
          );
          // Everything else is one-time; if it no longer fits, the oldest goes first.
          const rest = items.filter(
            (item) => item._tag !== "frame" && item._tag !== "control" && item._tag !== "viewport",
          );
          for (const item of [...rest.slice(state.length - VIEWER_OUTPUT_LIMIT), ...state])
            Queue.offerUnsafe(output, item);
          for (const item of dropped.value) if (item._tag === "frame") runFork(item.ack);
        }
      },
      pause: (signal, timeoutMs = 10_000) => {
        const previous = screencastParams;
        const paused = ServerBrowserPage.withReadBudget({ signal, timeoutMs }, async (read) => {
          await read("viewer parameters", () => previous);
          await read("viewer screencast pause", () => session.send("Page.stopScreencast"));
        });
        screencastParams = paused.then(constVoid, constVoid);
        return paused;
      },
      resume: (timeoutMs) => startScreencast(screencastScale, timeoutMs),
      scrolledAt: 0,
      requestedSize: null,
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        tab.viewers.add(viewer);
        tab.viewerAttached?.resolve();
        tab.viewerAttached = null;
        reportLiveTabs();
      }),
      () =>
        Effect.promise(async () => {
          await tab.control.disconnect(viewer.id, () => releaseViewerInput(tab, viewer, session));
          tab.viewers.delete(viewer);
          broadcastControl(tab);
          reportLiveTabs();
          if (!tab.closing && viewer.requestedSize !== null && tab.setting._tag === "fill")
            await applySetting(tab, tab.setting).catch(constVoid);
        }),
    );
    if (input.canOperate && tab.control.agentId === null && tab.control.controller === null) {
      yield* Effect.promise(() => tab.control.take(viewer.id));
    }
    broadcastControl(tab);
    pushFileChooser(tab);
    const pushStill = async () => {
      const data = await withCaptureLock(tab, async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            ServerBrowserPage.captureViewport(session, { format: "jpeg", quality }),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), VIEWER_STILL_TIMEOUT_MS);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }).catch(() => null);
      if (data) viewer.push({ _tag: "frame", data: Buffer.from(data, "base64"), ack: Effect.void });
    };
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (settleTimer !== null) clearTimeout(settleTimer);
      }),
    );
    let screencastStarted = false;
    session.on("Page.screencastFrame", (frame) => {
      screencastStarted = true;
      if (framesInFlight > 0) mayHaveDropped = true;
      framesInFlight += 1;
      const arrivedAt = Date.now();
      recentFrames.push(arrivedAt);
      while (recentFrames[0]! < arrivedAt - SCREENCAST_MOTION_WINDOW_MS) recentFrames.shift();
      if (
        !motion &&
        recentFrames.length >= SCREENCAST_MOTION_FRAMES &&
        arrivedAt - viewer.scrolledAt < SCREENCAST_MOTION_WINDOW_MS
      ) {
        motion = true;
        void startScreencast(0.5);
      } else if (motion && arrivedAt - viewer.scrolledAt > SCREENCAST_SETTLE_MS) {
        motion = false;
        recentFrames.length = 0;
        void startScreencast(1);
      }
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (!motion && !mayHaveDropped) return;
        mayHaveDropped = false;
        if (motion) {
          motion = false;
          recentFrames.length = 0;
          void startScreencast(1);
        }
        void pushStill();
      }, SCREENCAST_SETTLE_MS);
      viewer.push({
        _tag: "frame",
        data: Buffer.from(frame.data, "base64"),
        ack: Effect.promise(() =>
          sleepUntil(arrivedAt + SCREENCAST_ACK_PACE_MS).then(() => {
            framesInFlight -= 1;
            return session
              .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
              .catch(constVoid);
          }),
        ),
      });
    });
    void broadcastViewport(tab).catch(constVoid);
    yield* Effect.promise(() => startScreencast(1));
    // An idle page does not repaint for a new screencast, so the viewer
    // starts from a still unless a live frame beat it.
    if (!screencastStarted) yield* Effect.forkScoped(Effect.promise(pushStill));
    return {
      output,
      input: (raw: unknown) =>
        Effect.promise(async () => {
          if (!viewer.canOperate) return;
          const message = asRecord(raw);
          if (!message) return;
          try {
            if (message.type === "takeControl") {
              const taking = tab.control.take(viewer.id);
              broadcastControl(tab);
              await taking;
              broadcastControl(tab);
              pushFileChooser(tab);
            } else if (message.type === "releaseControl") {
              const releasing = tab.control.release(viewer.id, () =>
                releaseViewerInput(tab, viewer, session),
              );
              broadcastControl(tab);
              await releasing;
            } else if (
              message.type === "dialog" &&
              tab.control.controller === viewer.id &&
              typeof message.accept === "boolean"
            ) {
              await resolveDialog(tab, {
                accept: message.accept,
                ...(typeof message.promptText === "string"
                  ? { promptText: message.promptText }
                  : {}),
              });
            } else {
              const dispatch = async (input: Record<string, unknown>) => {
                tab.threadLinkViewer = viewer;
                try {
                  return await dispatchViewerInput(tab, session, viewer, input);
                } finally {
                  tab.threadLinkViewer = null;
                }
              };
              const dispatchLatest = async (input: Record<string, unknown>) => {
                await dispatch(input);
              };
              if (
                message.type === "mouse" &&
                message.action === "move" &&
                message.button === "none" &&
                message.buttons === 0
              ) {
                await tab.control.humanLatest(
                  viewer.id,
                  `hover:${modifiersOf(message)}`,
                  message,
                  dispatchLatest,
                );
              } else if (message.type === "wheel") {
                // A reversal stays separate so scrolling clamped at an edge behaves as if unmerged.
                await tab.control.humanLatest(
                  viewer.id,
                  `wheel:${num(message.x)}:${num(message.y)}:${modifiersOf(message)}:${Math.sign(num(message.deltaX))}:${Math.sign(num(message.deltaY))}`,
                  message,
                  dispatchLatest,
                  (waiting, next) => ({
                    ...next,
                    deltaX: num(waiting.deltaX) + num(next.deltaX),
                    deltaY: num(waiting.deltaY) + num(next.deltaY),
                  }),
                );
              } else {
                const copyRead = await tab.control.human(viewer.id, () => dispatch(message));
                await copyRead?.();
              }
            }
          } catch {
            broadcastControl(tab);
          }
        }),
    } satisfies ServerBrowserViewer;
  });

  yield* manager.events.pipe(Stream.runForEach(mirrorManagerEvent), Effect.forkScoped);
  yield* desktopChannel.connectedHosts.pipe(
    Stream.tap((desktopHostId) => desktopChannel.reconcileRoots(desktopHostId, serverEpoch)),
    Stream.runForEach((desktopHostId) =>
      Effect.forEach(
        [...nativePopups.values()].filter(
          (popup) => (popup.source.desktopHostId ?? "local") === desktopHostId,
        ),
        (popup) =>
          Effect.gen(function* () {
            const id = popupKey(popup.source, popup.popupId);
            const presence = yield* desktopChannel
              .probePopup(popup.source, popup.popupId)
              .pipe(Effect.option);
            if (nativePopups.get(id) !== popup || Option.isNone(presence)) return;
            if (!presence.value) return yield* confirmNativePopupClosed(id, popup);
            if (!popup.closeRequested) return;
            yield* popup.snapshot
              ? manager
                  .close({
                    threadId: ThreadId.make(popup.snapshot.threadId),
                    tabId: popup.snapshot.tabId,
                  })
                  .pipe(Effect.ignore)
              : desktopChannel.closePopup(popup.source, popup.popupId).pipe(Effect.ignore);
          }),
        { discard: true },
      ).pipe(
        Effect.andThen(
          Effect.forEach(
            [...nativeRoots.values()].filter(
              (root) =>
                !root.closed &&
                root.rootId !== null &&
                (root.key.desktopHostId ?? "local") === desktopHostId,
            ),
            (root) =>
              Effect.gen(function* () {
                const rootId = root.rootId!;
                const presence = yield* desktopChannel
                  .probeRoot(root.key, rootId)
                  .pipe(Effect.option);
                if (
                  nativeRoots.get(tabKey(root.key.threadId, root.key.tabId)) !== root ||
                  root.rootId !== rootId ||
                  Option.isNone(presence)
                )
                  return;
                if (!presence.value)
                  return yield* confirmNativeRootClosed({ ...root.key, rootId }, root);
                if (!root.closeRequested) return;
                yield* root.published
                  ? manager
                      .close({
                        threadId: ThreadId.make(root.key.threadId),
                        tabId: root.key.tabId,
                      })
                      .pipe(Effect.ignore)
                  : desktopChannel.cancelRootCreation(root.key, rootId);
              }),
            { discard: true },
          ),
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* desktopChannel.popups.pipe(
    Stream.runForEach((popup) => Effect.promise(() => openNativePopup(popup))),
    Effect.forkScoped,
  );
  yield* desktopChannel.closedPopups.pipe(
    Stream.runForEach((event) => confirmNativePopupClosed(popupKey(event, event.popupId))),
    Effect.forkScoped,
  );
  yield* desktopChannel.closedRoots.pipe(
    Stream.runForEach((event) => confirmNativeRootClosed(event)),
    Effect.forkScoped,
  );
  yield* desktopChannel.dormant.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const { sessions } = yield* manager.list({ threadId: ThreadId.make(event.threadId) });
        const snapshot = sessions.find((session) =>
          event.popupId === undefined
            ? session.tabId === event.tabId
            : session.desktopPopupId === event.popupId,
        );
        const popup =
          event.popupId === undefined
            ? undefined
            : (nativePopups.get(popupKey(event, event.popupId)) ??
              nativePopupForTab(event.threadId, event.tabId));
        if (!snapshot && popup) {
          popup.closed = true;
          nativePopups.delete(popupKey(popup.source, popup.popupId));
          return;
        }
        if (
          !snapshot ||
          snapshot.runtime !== "server" ||
          (snapshot.desktopHostId ?? "local") !== (event.desktopHostId ?? "local")
        )
          return;
        const key = tabKey(snapshot.threadId, snapshot.tabId);
        const root = nativeRoots.get(key);
        if (
          event.rootId !== undefined &&
          (!root || root.rootId !== event.rootId || !root.published)
        )
          return;
        if (event.popupId !== undefined && (!popup || popup.popupId !== event.popupId)) return;
        if (
          event.rootId === undefined &&
          event.popupId === undefined &&
          snapshot.runtime === "server" &&
          snapshot.backingPage !== "desktop"
        )
          return;
        yield* manager
          .nativeDormantConfirmed({
            threadId: ThreadId.make(event.threadId),
            tabId: snapshot.tabId,
          })
          .pipe(
            Effect.tapError((cause) =>
              Effect.logError("Could not save unloaded native preview; retrying.", { cause }),
            ),
            Effect.retry({
              while: (cause) => cause._tag === "PreviewSessionStorageError",
              schedule: Schedule.spaced("5 seconds"),
            }),
            Effect.catchTags({ PreviewSessionLookupError: () => Effect.void }),
          );
        nativeRoots.delete(key);
        if (popup) nativePopups.delete(popupKey(popup.source, popup.popupId));
        const tab = tabs.get(key);
        if (tab?.desktop) dropTab(tab, false);
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logError("Could not save unloaded native preview.", { cause }),
        ),
        Effect.ignore,
      ),
    ),
    Effect.forkScoped,
  );
  // Whoever runs the server learns the fix before anyone opens a tab.
  if (
    !PreviewBrowserHost.sandboxDisabled(yield* HostProcess.Environment) &&
    (yield* PreviewBrowserHost.sandboxBlocked)
  ) {
    yield* Effect.logWarning(
      `This host blocks the sandbox T3's browser runs in, so browser tabs and HTML previews will not start. Run \`${setupCommand}\` once to allow it.`,
    );
  }

  yield* desktopChannel.detached.pipe(
    Stream.runForEach((key) =>
      Effect.gen(function* () {
        yield* syncNativeHostingPresentation(key);
        const tab = tabs.get(tabKey(key.threadId, key.tabId));
        if (tab?.desktop && (tab.desktopHostId ?? "local") === (key.desktopHostId ?? "local"))
          dropTab(tab, false);
      }).pipe(Effect.ignore),
    ),
    Effect.forkScoped,
  );
  yield* desktopChannel.presentations.pipe(
    Stream.runForEach((key) =>
      Effect.gen(function* () {
        yield* syncNativeHostingPresentation(key);
        const tab = tabs.get(tabKey(key.threadId, key.tabId));
        if (!tab?.desktop || tab.desktopHostId !== key.desktopHostId) return;
        tab.nativePresented = desktopChannel.isPresented(key);
        if (tab.nativePresented) tab.revealRequested = false;
        reportLiveTabs();
      }).pipe(Effect.ignore),
    ),
    Effect.forkScoped,
  );
  // The desktop keeps the tabs an agent uses focused until its turn ends, not just per command.
  yield* Stream.fromSubscription(agentTurns).pipe(
    Stream.runForEach((change) => desktopChannel.turn(change.threadId, change.active)),
    Effect.forkScoped,
  );
  // Reconnect returned pages immediately so all clients keep receiving URL and title changes.
  yield* desktopChannel.attached.pipe(
    Stream.runForEach((key) =>
      Effect.gen(function* () {
        if (tabs.has(tabKey(key.threadId, key.tabId))) return;
        const { sessions } = yield* manager.list({ threadId: ThreadId.make(key.threadId) });
        const snapshot = sessions.find(
          (session) => session.tabId === key.tabId && session.runtime === "server",
        );
        if (snapshot) yield* Effect.promise(() => ensureTab(snapshot).catch(constVoid));
      }).pipe(Effect.ignore),
    ),
    Effect.forkScoped,
  );
  yield* Effect.sync(closeIdleHeadlessTabs).pipe(
    Effect.repeat(Schedule.spaced(IDLE_SWEEP_INTERVAL)),
    Effect.forkScoped,
  );
  const environmentId = yield* environment.getEnvironmentId;
  const hostSession = broker
    .connect(
      {
        clientId: SERVER_HOST_CLIENT_ID,
        environmentId,
        supportedOperations: [...PREVIEW_AUTOMATION_SERVER_OPERATIONS],
      },
      { preferred: true, disconnectOnTimeout: false },
    )
    .pipe(
      Effect.flatMap((events) =>
        events.pipe(
          Stream.runForEach((event) => {
            if (event.type === "connected") {
              hostConnectionId = event.connectionId;
              return Effect.sync(reportLiveTabs);
            }
            return broker
              .runRequest(
                {
                  clientId: SERVER_HOST_CLIENT_ID,
                  connectionId: event.connectionId,
                  requestId: event.request.requestId,
                },
                (remainingTimeoutMs) =>
                  handleRequest(event.connectionId, {
                    ...event.request,
                    timeoutMs: remainingTimeoutMs,
                  }),
              )
              .pipe(Effect.forkScoped, Effect.asVoid);
          }),
        ),
      ),
    );
  // Re-register after transport loss; individual request deadlines keep this host alive.
  yield* hostSession.pipe(
    Effect.exit,
    Effect.andThen(Effect.sleep(HOST_RECONNECT_DELAY)),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      // Closing Chromium during shutdown must not delete the saved handoffs it rendered.
      for (const tab of tabs.values()) dropTab(tab, false);
      await contexts.close();
      while (pendingReports.size > 0 || backgroundFibers.size > 0) {
        await Promise.allSettled(pendingReports);
        await runPromise(Fiber.awaitAll([...backgroundFibers]));
      }
    }),
  );

  const clearProfile = (profileId: string) =>
    Effect.tryPromise({
      try: () => contexts.clearProfile(profileId),
      catch: (cause) => new PreviewClearProfileError({ profileId, cause }),
    });

  return ServerBrowser.of({
    attachViewer,
    clearProfile,
    profileReporter,
    openDownload,
    answerFileChooser,
  });
});

export const layer = Layer.effect(ServerBrowser, make);
