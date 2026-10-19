// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.
// Screencasts ignore emulated device scale; real 2x keeps captures sharp.
// --disable-gpu uses cheaper software compositing while preserving SwiftShader WebGL.
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  FILL_PREVIEW_VIEWPORT,
  findBrowserProfile,
  INCOGNITO_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
  type BrowserProfile,
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
  type PreviewAutomationNavigateInput,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationRequest,
  type PreviewAutomationResizeInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSelectInput,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationStatus,
  type PreviewAutomationTypeInput,
  type PreviewAutomationUploadInput,
  type PreviewAutomationWaitForInput,
  DesktopBrowserTransportError,
  PreviewClearProfileError,
  PreviewNativeCloseError,
  type PreviewEvent,
  type PreviewNavStatus,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
  ThreadId,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  type PreviewAppearancePreference,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as Mime from "effect/http/Mime";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { constVoid } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
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
import { resolveRootCliCommand } from "../cli/invocation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import * as PreviewManager from "./Manager.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";
import { presentAsChrome, ServerBrowserContexts } from "./ServerBrowserContexts.ts";
import { BrowserControlInterrupted, SessionControl } from "./SessionControl.ts";
import { installPdfDocumentNavigation, isPdfAssetUrl } from "./PdfDocumentNavigation.ts";

const SERVER_HOST_CLIENT_ID = SERVER_BROWSER_AUTOMATION_CLIENT_ID;
const RENDER_SCALE = 2;
// Chromium allows three unacked frames, so 100 ms pacing caps viewers near 30 fps.
const SCREENCAST_ACK_PACE_MS = 100;
const SCREENCAST_SETTLE_MS = 200;
const SCREENCAST_MOTION_FRAMES = 4;
const SCREENCAST_MOTION_WINDOW_MS = 300;
const SCREENCAST_MOTION_QUALITY = 50;
const HOST_RECONNECT_DELAY = "1 second";
/** How long a desktop-backed tab waits for its selected native host to attach. */
const DESKTOP_ATTACH_TIMEOUT = "10 seconds";
const VIEWER_OUTPUT_LIMIT = 64;
const RECORDING_SCREENCAST = { format: "jpeg", quality: 90, everyNthFrame: 1 } as const;
const decodeViewportSetting = Schema.decodeUnknownSync(PreviewViewportSettingSchema);
const isDesktopBrowserTransportError = Schema.is(DesktopBrowserTransportError);
const AGENT_CURSOR_MOVE_MS = 160;
const AGENT_CURSOR_CLICK_LEAD_MS = 40;

const sleepUntil = (deadline: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())));

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
      readonly controller: "agent" | "you" | "another-viewer" | "unclaimed";
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

    readonly reportProfiles: (input: PreviewReportProfilesInput) => Effect.Effect<void>;
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
  readonly createdAt: number;
  usedAt: number;
  readonly viewers: Set<ViewerState>;
  readonly consoleEntries: Array<PreviewAutomationConsoleEntry>;
  readonly networkEntries: Array<PreviewAutomationNetworkEntry>;
  readonly actionTimeline: Array<PreviewAutomationActionEvent>;
  readonly control: SessionControl;
  agentOperating: boolean;
  fileChooserIntercepted: boolean;
  readonly onFileChooser: (chooser: FileChooser) => void;

  readonly isolatedContext: boolean;

  readonly desktop: { readonly close: () => Promise<void> } | null;
  readonly profileId: string | undefined;
  readonly desktopHostId: string | undefined;
  nativePresented: boolean;
  revealRequested: boolean;
  readonly openerTabId: string | undefined;

  readonly downloads: Array<ServerDownload>;
  fileChooser: {
    readonly id: string;
    readonly chooser: FileChooser;
    readonly accept: string;
    readonly offeredTo: string | null;
  } | null;
  dialog: Dialog | null;
  setting: PreviewViewportSetting;
  colorScheme: PreviewAppearancePreference;
  zoomFactor: number;
  loading: boolean;
  navigationSequence: number;
  navigationFailed: boolean;
  closing: boolean;
  recording: Recording | null;
  initialNavigation: Promise<void> | null;
  navigationGeneration: number;

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

/**
 * Operations an agent may run on any tab in its thread, even while a human
 * drives it. Evaluate is not one: page script can change anything, so it needs
 * the same control as clicking.
 */
const READ_OPERATIONS: ReadonlySet<PreviewAutomationRequest["operation"]> = new Set([
  "status",
  "snapshot",
  "waitFor",
]);

const AGENT_TAB_LIMIT = 8;
const SERVER_TAB_LIMIT = 32;
const AGENT_TAB_IDLE_MS = 30 * 60 * 1000;
const IDLE_SWEEP_INTERVAL = "1 minute";

const DOWNLOAD_LIMIT = 20;
const ABORTED_NAVIGATION_DOWNLOAD_WAIT_MS = 5_000;
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

// Cmd shortcuts from Apple viewers are no editing shortcut for Linux or headless
// Chromium, so they carry the command. Ctrl already works natively on Linux,
// except copy and cut, which headless Chromium only runs as commands.
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
// Headless Chromium shares one clipboard between every context, so the copy
// a viewer's copy or cut key makes is read from this world instead of the
// clipboard. Page scripts cannot see the world, and only a copy made while a
// real key is handled counts.
const CLIPBOARD_SCRIPT = `(() => {
  let keying = false;
  let copied = "";
  // The same Ctrl or Cmd + C or X that editingCommand sends as copy or cut.
  addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.altKey || event.ctrlKey === event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key !== "c" && key !== "x") return;
    keying = true;
    copied = "";
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
    copied = String(text ?? "").slice(0, ${CLIPBOARD_TEXT_LIMIT});
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
  globalThis.takeCopy = () => {
    const text = copied;
    copied = "";
    return text;
  };
})();`;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const host = { platform: yield* HostProcess.Platform, arch: yield* HostProcess.Architecture };
  const manager = yield* PreviewManager.PreviewManager;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const previewBrowser = yield* PreviewBrowser.PreviewBrowser;
  const desktopChannel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const launchServices = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  const setupCommand = yield* resolveRootCliCommand(PreviewBrowserHost.SETUP_SUBCOMMAND);

  const tabs = new Map<string, ServerTab>();
  const pendingTabs = new Map<string, Promise<ServerTab>>();

  const closedPendingTabs = new Set<string>();
  const adoptedPages = new Map<string, { readonly page: Page; readonly openerTabId: string }>();
  const nativePopups = new Map<
    string,
    {
      readonly source: DesktopBrowserChannel.DesktopTabKey;
      readonly popupId: string;
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
  const confirmNativePopupClosed = (id: string, popup = nativePopups.get(id)) =>
    Effect.gen(function* () {
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
  const closedSessions = new Set<string>();
  let hostConnectionId: string | null = null;
  let viewerResizeOrder = 0;

  const contexts = new ServerBrowserContexts({
    profilesDir: NodePath.join(config.stateDir, "server-browser", "profiles"),
    executable: () => Effect.runPromise(previewBrowser.executable),
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
        if (tab.page.context() === context) dropTab(tab, true);
      }
    },
  });

  const dialogStatus = (tab: ServerTab) =>
    tab.dialog
      ? {
          type: tab.dialog.type(),
          message: tab.dialog.message().slice(0, 4000),
          defaultValue: tab.dialog.defaultValue().slice(0, 4000),
        }
      : null;

  const updateFileChooserInterception = (tab: ServerTab) => {
    // Native desktop views use the OS picker. Only agents and streamed controllers
    // have an uploader that can answer an intercepted request.
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
            ? "you"
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

  const report = (tab: ServerTab, navStatus: PreviewNavStatus) => {
    const sequence = ++tab.navigationSequence;
    void tab.cdp
      .send("Page.getNavigationHistory")
      .catch(() => null)
      .then((history) => {
        if (tab.closing || tab.navigationSequence !== sequence) return;
        const index = history?.currentIndex ?? 0;
        const count = history?.entries.length ?? 0;
        runFork(
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
  };

  const reportLoaded = async (tab: ServerTab, sampleCurrentNavigation = false) => {
    const sequence = tab.navigationSequence;
    const url = tab.page.url();
    // Chromium's error page loads after `requestfailed` and must not clear LoadFailed.
    if (url === "about:blank" || url.startsWith("chrome-error://")) return;
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
      tab.page.url() !== url
    )
      return;
    report(tab, { _tag: "Success", url: url.slice(0, 2048), title });
  };

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

  const layoutSize = (tab: ServerTab) => {
    const size = tab.page.viewportSize();
    if (!size || tab.desktop) return size;
    return {
      width: Math.max(1, Math.round(size.width / tab.zoomFactor)),
      height: Math.max(1, Math.round(size.height / tab.zoomFactor)),
    };
  };

  const applyZoom = async (tab: ServerTab) => {
    if (tab.desktop) return;
    const size = tab.page.viewportSize();
    if (!size) return;
    if (tab.zoomFactor === 1) {
      await tab.page.setViewportSize(size);
      return;
    }
    const layout = layoutSize(tab)!;
    await tab.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: layout.width,
      height: layout.height,
      deviceScaleFactor: RENDER_SCALE * tab.zoomFactor,
      mobile: false,
    });
  };

  const broadcastViewport = (tab: ServerTab) => {
    const size = layoutSize(tab);
    if (!size) return;
    for (const viewer of tab.viewers) viewer.push({ _tag: "viewport", ...size });
  };

  const applySetting = async (tab: ServerTab, setting: PreviewViewportSetting) => {
    tab.setting = setting;

    if (tab.desktop) return;
    const size =
      fixedViewportSize(setting) ??
      [...tab.viewers]
        .map((viewer) => viewer.requestedSize)
        .filter((requested) => requested !== null)
        .sort((left, right) => right.order - left.order)[0] ??
      UNATTACHED_FILL_VIEWPORT;
    await tab.page.setViewportSize({ width: size.width, height: size.height });
    await applyZoom(tab);
    broadcastViewport(tab);
  };

  const applyRendering = async (tab: ServerTab, snapshot: PreviewSessionSnapshot) => {
    const colorScheme = snapshot.colorScheme ?? "system";
    if (colorScheme !== tab.colorScheme) {
      tab.colorScheme = colorScheme;
      await tab.page.emulateMedia({ colorScheme: colorScheme === "system" ? null : colorScheme });
    }
    const zoomFactor = snapshot.zoomFactor ?? 1;
    if (zoomFactor !== tab.zoomFactor && !tab.desktop) {
      tab.zoomFactor = zoomFactor;
      await applyZoom(tab);
      broadcastViewport(tab);
    }
  };

  const sessionOpen = (tab: ServerTab) => !closedSessions.has(tabKey(tab.threadId, tab.tabId));

  const dropTab = (tab: ServerTab, closeSession: boolean) => {
    const key = tabKey(tab.threadId, tab.tabId);
    if (tabs.get(key) !== tab) return;
    tabs.delete(key);
    tab.closing = true;
    clearAbortedNavigation(tab);
    // A desktop page outlives the connection unless its session closed with it.
    const end = tab.desktop && !closeSession && sessionOpen(tab) ? "reconnect" : "gone";
    for (const viewer of tab.viewers) viewer.push({ _tag: end });
    void tab.control.close().catch(constVoid);
    if (tab.desktop) void tab.desktop.close().catch(constVoid);
    else void tab.page.close().catch(constVoid);
    if (tab.isolatedContext) void tab.page.context().close().catch(constVoid);
    void tab.recording?.encoder.close().catch(constVoid);
    void tab.recording?.releaseSurface();
    void NodeFSP.rm(downloadDir(tab), { recursive: true, force: true }).catch(constVoid);
    reportLiveTabs();
    if (closeSession) {
      runFork(manager.close({ threadId: tab.threadId, tabId: tab.tabId }).pipe(Effect.ignore));
    }
  };

  /** Wait only for the page owner chosen before the session was published. */
  const desktopRenders = (snapshot: PreviewSessionSnapshot) =>
    snapshot.backingPage === "desktop" || snapshot.backingPage === "desktop-popup"
      ? Effect.runPromise(
          desktopChannel.awaitAttached(
            {
              threadId: snapshot.threadId,
              tabId: snapshot.tabId,
              ...(snapshot.desktopHostId === undefined
                ? {}
                : { desktopHostId: snapshot.desktopHostId }),
            },
            DESKTOP_ATTACH_TIMEOUT,
          ),
        )
      : Promise.resolve(false);

  const connectDesktop = async (snapshot: PreviewSessionSnapshot) => {
    const scope = await Effect.runPromise(Scope.make());
    try {
      const endpoint = await Effect.runPromise(
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
          await Effect.runPromise(Scope.close(scope, Exit.void));
        },
      };
    } catch (cause) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw cause;
    }
  };

  const createTab = async (snapshot: PreviewSessionSnapshot): Promise<ServerTab> => {
    const adopted = adoptedPages.get(tabKey(snapshot.threadId, snapshot.tabId));
    adoptedPages.delete(tabKey(snapshot.threadId, snapshot.tabId));
    const nativePopup = nativePopupForTab(snapshot.threadId, snapshot.tabId);
    if (snapshot.backingPage === "desktop-popup") {
      if (!nativePopup || nativePopup.closed || nativePopup.popupId !== snapshot.desktopPopupId)
        throw new Error("The native popup binding is unavailable.");
      // A bound child survives channel reconnects and re-announces its server
      // key. Binding is only needed for the initial window announcement.
      if (!nativePopup.bound)
        await Effect.runPromise(
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
    if (nativePopup && desktop) nativePopup.bound = true;
    if (
      adopted === undefined &&
      (snapshot.backingPage === "desktop" || snapshot.backingPage === "desktop-popup") &&
      desktop === null
    ) {
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationRemoteUnavailableError",
        "The selected desktop browser did not attach. Keep that desktop connected and retry; the requested profile was not opened in another browser.",
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
    if (adopted?.page.isClosed()) throw new Error("The popup closed before it opened.");
    if (!desktop) await prepareContext(context);
    const page = adopted?.page ?? desktop?.page ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    await installPdfDocumentNavigation(cdp);
    // The desktop's page is already a normal browser. A popup's first request
    // went out before it became a tab; everything after presents as Chrome.
    if (!desktop) await presentAsChrome(cdp, host);
    if (!desktop) await recordCopies(cdp);
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    const control = new SessionControl(snapshot.automationOwner ?? null, () =>
      ServerBrowserPage.invalidateRefs(page),
    );
    const tab: ServerTab = {
      threadId: ThreadId.make(snapshot.threadId),
      tabId: snapshot.tabId,
      page,
      cdp,
      frameSessions: new Map(),
      createdAt: Date.now(),
      usedAt: Date.now(),
      viewers: new Set(),
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      control,
      agentOperating: false,
      fileChooserIntercepted: false,
      onFileChooser: (chooser) => void offerFileChooser(tab, chooser),
      isolatedContext,
      desktop: desktop === null ? null : { close: desktop.close },
      profileId: snapshot.profileId,
      desktopHostId: snapshot.desktopHostId,
      nativePresented: false,
      revealRequested: snapshot.reveal === true,
      openerTabId: adopted?.openerTabId ?? nativePopup?.source.tabId,
      downloads: [],
      fileChooser: null,
      dialog: null,
      setting: snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
      colorScheme: "system",
      zoomFactor: 1,
      loading: false,
      navigationSequence: 0,
      navigationFailed: snapshot.navStatus._tag === "LoadFailed",
      closing: false,
      recording: null,
      recordingStart: null,
      initialNavigation: null,
      navigationGeneration: 0,
      abortedNavigation: null,
      captureLock: Promise.resolve(),
      capturing: 0,
    };
    if (!desktop) {
      await page.setViewportSize(fixedViewportSize(tab.setting) ?? UNATTACHED_FILL_VIEWPORT);
    }
    await applyRendering(tab, snapshot);
    const isMainNavigation = (request: { isNavigationRequest(): boolean; frame(): unknown }) =>
      request.isNavigationRequest() && request.frame() === page.mainFrame();
    const navigationGenerations = new WeakMap<object, number>();
    page.on("request", (request) => {
      if (!isMainNavigation(request)) return;
      navigationGenerations.set(request, ++tab.navigationGeneration);
      clearAbortedNavigation(tab);
      tab.loading = true;
      tab.navigationFailed = false;
      report(tab, { _tag: "Loading", url: request.url().slice(0, 2048), title: "" });
    });
    page.on("load", () => {
      tab.loading = false;
      void reportLoaded(tab);
    });
    page.on("framenavigated", (frame) => {
      // Same-document navigations (SPA routes) fire no load event.
      if (frame === page.mainFrame() && !tab.loading) void reportLoaded(tab);
      if (!desktop) void recordFrameCopies(tab, frame);
    });
    // An adopted popup's frames may have loaded before the tab listened.
    if (adopted) for (const frame of page.frames()) void recordFrameCopies(tab, frame);
    page.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText ?? "";
      pushBounded(tab.networkEntries, {
        url: request.url(),
        method: request.method(),
        status: null,
        failed: true,
        errorText,
        timestamp: new Date().toISOString(),
      });
      if (!isMainNavigation(request)) return;
      // A navigation a newer one replaced leaves the status to the newer one. A
      // popup's first request can predate the listener, so it is untracked and
      // superseded by any tracked one.
      const generation = navigationGenerations.get(request) ?? 0;
      if (generation !== tab.navigationGeneration) return;
      // An aborted navigation is usually a download; its `download` event settles the status.
      if (errorText.includes("ERR_ABORTED")) {
        const url = request.url();
        const navigationGeneration = tab.navigationGeneration;
        clearAbortedNavigation(tab);
        tab.abortedNavigation = {
          url,
          generation: navigationGeneration,
          timer: setTimeout(() => {
            if (tab.abortedNavigation?.generation !== navigationGeneration) return;
            tab.abortedNavigation = null;
            if (!tab.closing) settleAbortedNavigation(tab, navigationGeneration, url, undefined);
          }, ABORTED_NAVIGATION_DOWNLOAD_WAIT_MS),
        };
        return;
      }
      tab.loading = false;
      tab.navigationFailed = true;
      const { code, description } = ServerBrowserPage.parseNetError(errorText);
      report(tab, {
        _tag: "LoadFailed",
        url: request.url().slice(0, 2048),
        title: "",
        code,
        description,
      });
    });
    page.on("response", (response) => {
      pushBounded(tab.networkEntries, {
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        failed: false,
        timestamp: new Date().toISOString(),
      });
    });
    page.on("console", (message) => {
      pushBounded(tab.consoleEntries, {
        level: message.type(),
        text: message.text().slice(0, 2_000),
        timestamp: new Date().toISOString(),
      });
    });
    page.on("dialog", (dialog) => {
      tab.dialog = dialog;
      broadcastControl(tab);
    });
    page.on("download", (download) => void saveDownload(tab, download));
    updateFileChooserInterception(tab);
    // Popups become tabs and keep `window.opener`, so sign-in popups can report back.
    // Electron announces its actual child window separately; its one-page relay
    // cannot synthesize a Playwright popup without losing native identity.
    if (!desktop) page.on("popup", (popup) => void adoptPopup(tab, popup));
    // Playwright cannot reload a crashed page, so it must leave the tab list.
    const key = tabKey(tab.threadId, tab.tabId);
    if (closedPendingTabs.delete(key) || nativePopup?.closed) {
      await control.close().catch(constVoid);
      if (desktop) await desktop.close().catch(constVoid);
      else await page.close().catch(constVoid);
      if (isolatedContext) await context.close().catch(constVoid);
      throw new ServerBrowserTabNotFoundError({ threadId: tab.threadId, tabId: tab.tabId });
    }
    page.on("close", () => dropTab(tab, true));
    page.on("crash", () => dropTab(tab, true));
    // Sample after all asynchronous setup, in the same tick that registers
    // the tab. The presentation subscriber handles every later change.
    tab.nativePresented =
      desktop !== null &&
      desktopChannel.isPresented({
        threadId: tab.threadId,
        tabId: tab.tabId,
        desktopHostId: tab.desktopHostId,
      });
    tabs.set(key, tab);
    reportLiveTabs();
    // Native/adopted pages may have finished before their listeners were installed.
    if (adopted || desktop) void reportLoaded(tab, true);
    // Existing desktop and popup PDFs can start loading before interception attaches.
    if (
      snapshot.navStatus._tag === "Loading" &&
      ((!adopted && !desktop) || isPdfAssetUrl(snapshot.navStatus.url))
    ) {
      const options = { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS } as const;
      tab.initialNavigation = (
        (desktop || adopted) && page.url() === snapshot.navStatus.url
          ? page.reload(options)
          : page.goto(snapshot.navStatus.url, options)
      ).then(constVoid);

      void tab.initialNavigation.catch(constVoid);
    }
    return tab;
  };

  const downloadsRoot = NodePath.join(config.stateDir, "server-browser", "downloads");
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

  const settleAbortedNavigation = (
    tab: ServerTab,
    generation: number,
    url: string,
    offered: { readonly id: string; readonly fileName: string } | undefined,
  ) => {
    if (tab.navigationGeneration !== generation) return;
    tab.loading = false;
    if (tab.page.url() !== "about:blank") {
      void reportLoaded(tab);
      return;
    }
    report(tab, {
      _tag: "LoadFailed",
      url: url.slice(0, 2048),
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
      await NodeFSP.mkdir(downloadDir(tab), { recursive: true });
      await download.saveAs(path);
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
        url: download.url().slice(0, 2048),
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
        settleAbortedNavigation(tab, navigation, download.url(), offered);
      }
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

  const offerFileChooser = async (tab: ServerTab, chooser: FileChooser) => {
    const previous = tab.fileChooser;
    const accept =
      (await chooser
        .element()
        .getAttribute("accept")
        .catch(() => null)) ?? "";
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
      // A new controller gets a fresh id; the previous one can no longer answer.
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
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        `Upload paths must be absolute: ${relative}`,
      );
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
                  throw new ServerBrowserPage.ServerBrowserOperationError(
                    "PreviewAutomationExecutionError",
                    "Remote browser uploads must be regular files totaling at most 64 MiB.",
                  );
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
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "No file picker is open. Click the page's upload control first, or pass the file input's locator.",
      );
    if (input.paths.length > 1 && !open.chooser.isMultiple())
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "This file picker accepts one file.",
      );
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

  /**
   * A frame in its own process, such as one with an `Origin-Agent-Cluster`
   * header, is out of the page session's reach, so it records copies through
   * its own session until that target closes.
   */
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

  const takeSessionCopies = async (cdp: CDPSession) => {
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
              expression: "globalThis.takeCopy?.()",
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

  const takeCopiedText = async (tab: ServerTab) => {
    const copies = await Promise.all(
      [tab.cdp, ...tab.frameSessions.values()].map(takeSessionCopies),
    );
    return copies.flat().find((text) => text.length > 0);
  };

  const adoptPopup = async (opener: ServerTab, popup: Page) => {
    const agentId = opener.control.agentId;
    if (opener.closing || (agentId !== null && atTabLimit(agentId))) {
      await popup.close().catch(constVoid);
      return;
    }
    const url = popup.url();

    const controller = [...opener.viewers].find(
      (viewer) => viewer.id === opener.control.controller,
    );
    await Effect.runPromise(
      manager.open({
        threadId: opener.threadId,
        ...(/^https?:/i.test(url) ? { url } : {}),
        runtime: "server",
        ...(opener.profileId === undefined ? {} : { profileId: opener.profileId }),
        ...(opener.desktopHostId === undefined ? {} : { desktopHostId: opener.desktopHostId }),
        ...(opener.control.agentId === null
          ? {}
          : { automationOwner: opener.control.agentId, reveal: false }),
        beforePublish: (snapshot) =>
          adoptedPages.set(tabKey(snapshot.threadId, snapshot.tabId), {
            page: popup,
            openerTabId: opener.tabId,
          }),
      }),
    ).then(
      (snapshot) => {
        if (opener.control.agentId === null)
          controller?.push({ _tag: "popup", tabId: snapshot.tabId });
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
        await Effect.runPromise(
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
      snapshot: null as PreviewSessionSnapshot | null,
      closed: false,
      closeRequested: false,
      bound: false,
    };
    nativePopups.set(id, popup);
    let opener =
      tabs.get(tabKey(source.threadId, source.tabId)) ??
      (await pendingTabs.get(tabKey(source.threadId, source.tabId))?.catch(() => undefined));
    if (!opener && !popup.closed) {
      const { sessions } = await Effect.runPromise(
        manager.list({ threadId: ThreadId.make(source.threadId) }),
      );
      const snapshot = sessions.find(
        (session) =>
          session.tabId === source.tabId &&
          session.runtime === "server" &&
          (session.backingPage === "desktop" || session.backingPage === "desktop-popup") &&
          (session.desktopHostId ?? "local") === (source.desktopHostId ?? "local"),
      );
      if (snapshot) opener = await ensureTab(snapshot).catch(() => undefined);
    }
    if (
      !opener?.desktop ||
      popup.closed ||
      opener.closing ||
      (opener.desktopHostId ?? "local") !== (source.desktopHostId ?? "local") ||
      (opener.control.agentId !== null && atTabLimit(opener.control.agentId))
    ) {
      popup.closeRequested = true;
      if (!popup.closed)
        await Effect.runPromise(desktopChannel.closePopup(source, source.popupId)).catch(constVoid);
      if (popup.closed) nativePopups.delete(id);
      return;
    }
    try {
      const snapshot = await Effect.runPromise(
        manager.open({
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
        await Effect.runPromise(
          manager.nativeClosedConfirmed({ threadId: opener.threadId, tabId: snapshot.tabId }),
        );
    } catch {
      popup.closeRequested = true;
      if (!popup.closed)
        await Effect.runPromise(desktopChannel.closePopup(source, source.popupId)).catch(constVoid);
      if (popup.closed) nativePopups.delete(id);
    }
  };

  const ensureTab = (snapshot: PreviewSessionSnapshot): Promise<ServerTab> => {
    const key = tabKey(snapshot.threadId, snapshot.tabId);
    const pending = pendingTabs.get(key);
    if (pending) return pending;
    const existing = tabs.get(key);
    if (existing) return Promise.resolve(existing);
    const opening = createTab(snapshot)
      .catch((cause: unknown) => {
        if (snapshot.backingPage === "desktop-popup")
          runFork(
            manager
              .close({ threadId: ThreadId.make(snapshot.threadId), tabId: snapshot.tabId })
              .pipe(Effect.ignore),
          );
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
        closedPendingTabs.delete(key);
      });
    pendingTabs.set(key, opening);
    return opening;
  };

  const findTab = (threadId: string, tabId: string) =>
    Effect.gen(function* () {
      const existing = tabs.get(tabKey(threadId, tabId));
      if (existing) return existing;
      const { sessions } = yield* manager.list({ threadId: ThreadId.make(threadId) });
      const snapshot = sessions.find(
        (session) => session.tabId === tabId && session.runtime === "server",
      );
      if (!snapshot) return yield* new ServerBrowserTabNotFoundError({ threadId, tabId });
      return yield* Effect.tryPromise({
        try: () => ensureTab(snapshot),
        catch: (cause) => (isTabNotFound(cause) ? cause : new ServerBrowserLaunchError({ cause })),
      });
    });

  const atTabLimit = (agentSessionId: string) =>
    tabs.size + pendingTabs.size >= SERVER_TAB_LIMIT ||
    [...tabs.values()].filter((tab) => tab.control.agentId === agentSessionId).length >=
      AGENT_TAB_LIMIT;

  const assertTabCapacity = (agentSessionId: string) => {
    if (atTabLimit(agentSessionId))
      throw new BrowserControlInterrupted(
        `Too many server browser tabs are open (${AGENT_TAB_LIMIT} per agent session, ${SERVER_TAB_LIMIT} per server). Close one with t3_preview_close or reuse one from preview_status tabs.`,
        "tabLimit",
      );
  };

  // Desktop browsing bypasses streamed viewers and server input tracking,
  // so these idle signals only apply to headless tabs.
  const closeIdleAgentTabs = () => {
    const cutoff = Date.now() - AGENT_TAB_IDLE_MS;
    for (const tab of tabs.values()) {
      if (
        tab.control.agentId !== null &&
        tab.desktop === null &&
        tab.viewers.size === 0 &&
        tab.usedAt < cutoff
      )
        dropTab(tab, true);
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
          Number(right.viewers.size > 0) - Number(left.viewers.size > 0) ||
          right.usedAt - left.usedAt,
      )[0]
    );
  };

  const tabOwner = (tab: ServerTab) =>
    tab.control.controller !== null
      ? ("human" as const)
      : tab.control.agentId !== null
        ? ("agent" as const)
        : ("unclaimed" as const);

  let reportedProfiles: {
    readonly profiles: ReadonlyArray<BrowserProfile>;
    readonly defaultProfileId: string;
  } | null = null;

  const reportProfiles: ServerBrowser["Service"]["reportProfiles"] = (input) =>
    Effect.sync(() => {
      const profiles = resolveBrowserProfiles(input.profiles);
      reportedProfiles = {
        profiles,
        defaultProfileId:
          findBrowserProfile(profiles, input.defaultProfileId)?.id ?? DEFAULT_BROWSER_PROFILE_ID,
      };
    });

  const profileStatus = () => {
    const profiles = reportedProfiles?.profiles ?? BUILT_IN_BROWSER_PROFILES;
    return {
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        ...(profile.kind === "incognito" ? { incognito: true } : {}),
      })),
      ...(reportedProfiles ? { defaultProfileId: reportedProfiles.defaultProfileId } : {}),
    };
  };

  const resolveOpenProfile = (requested: string | undefined): string | undefined => {
    if (requested === undefined) return reportedProfiles?.defaultProfileId;
    const profiles = reportedProfiles?.profiles ?? BUILT_IN_BROWSER_PROFILES;
    const wanted = requested.toLowerCase();
    const match =
      findBrowserProfile(profiles, requested) ??
      profiles.find((profile) => profile.name.toLowerCase() === wanted);
    if (match) return match.id;
    throw new ServerBrowserPage.ServerBrowserOperationError(
      "PreviewAutomationUnknownProfileError",
      `No browser profile is named "${requested}". Use one of: ${profiles
        .map((profile) => `${profile.name} (id ${profile.id})`)
        .join(", ")}.`,
    );
  };

  const statusWithTitle = async (
    tab: ServerTab | undefined,
    agentSessionId?: string,
  ): Promise<PreviewAutomationStatus> => {
    if (!tab) {
      return {
        available: false,
        visible: false,
        nativePresented: false,
        streamViewers: 0,
        revealRequested: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
        ...profileStatus(),
      };
    }
    const url = tab.page.url();
    const viewport = tab.page.viewportSize();
    if (tab.desktop)
      tab.nativePresented = desktopChannel.isPresented({
        threadId: tab.threadId,
        tabId: tab.tabId,
        desktopHostId: tab.desktopHostId,
      });
    // A reveal response only confirms the request. Presentation comes from
    // the actual native slot or an attached streamed viewer.
    if (tab.nativePresented || tab.viewers.size > 0) tab.revealRequested = false;
    const catalogue =
      tab.desktopHostId === undefined || agentSessionId === undefined
        ? null
        : await Effect.runPromise(
            desktopChannel.getProfiles({ threadId: tab.threadId, agentSessionId }),
          );
    const status = {
      profileId: tab.profileId ?? null,
      profileName:
        catalogue?.desktopHostId === tab.desktopHostId
          ? (catalogue?.profiles.find((profile) => profile.id === tab.profileId)?.name ?? null)
          : null,
      available: true,
      visible: tab.nativePresented || tab.viewers.size > 0,
      nativePresented: tab.nativePresented,
      streamViewers: tab.viewers.size,
      revealRequested: tab.revealRequested,
      tabId: tab.tabId,
      url: url === "about:blank" ? null : url,
      title: null,
      loading: tab.loading,
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
      tabs: [...tabs.values()]
        .filter((candidate) => candidate.threadId === tab.threadId)
        .map((candidate) => ({
          tabId: candidate.tabId,
          url: candidate.page.url() === "about:blank" ? null : candidate.page.url(),
          ...(candidate.openerTabId === undefined ? {} : { openerTabId: candidate.openerTabId }),
          owner: tabOwner(candidate),
          ownedByCaller: candidate.control.agentId === agentSessionId,
          visible: candidate.viewers.size > 0,
          ...(candidate.profileId === undefined ? {} : { profileId: candidate.profileId }),
        })),
      ...profileStatus(),
      downloads: tab.downloads.map(({ fileName, path, sizeBytes, url, completedAt }) => ({
        fileName,
        path,
        sizeBytes,
        url,
        completedAt,
      })),
    };
    if (status.url === null || tab.dialog) return status;
    return { ...status, title: (await tab.page.title().catch(() => "")) || null };
  };

  const resolveNavigationUrl = (input: PreviewAutomationNavigateInput) => {
    if (input.url !== undefined) return normalizePreviewUrl(input.url);
    const target = input.target!;
    if (target.kind === "url") return normalizePreviewUrl(target.url);

    const path = target.path ?? "";
    return `${target.protocol ?? "http"}://localhost:${target.port}${path.startsWith("/") || path === "" ? path : `/${path}`}`;
  };

  const navigate = async (
    tab: ServerTab,
    url: string,
    readiness: "load" | "domContentLoaded" | "none",
    timeout: number,
  ) => {
    const navigation = tab.page.goto(url, {
      timeout,
      waitUntil:
        readiness === "domContentLoaded"
          ? "domcontentloaded"
          : readiness === "none"
            ? "commit"
            : "load",
    });
    if (readiness === "none") {
      tab.control.track(navigation);
      return;
    }
    await navigation.catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("Download is starting")) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          `${url} is a file this browser cannot show, so it was downloaded instead. preview_status lists it under downloads.`,
        );
      }
      if (/ERR_[A-Z_]+/.test(message)) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          `Navigation to ${url} failed: ${ServerBrowserPage.parseNetError(message).description}`,
        );
      }
      throw cause;
    });
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
          throw new BrowserControlInterrupted("The recording start was interrupted.");
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
              openedEncoder.evaluate(ServerBrowserPage.RECORDING_ENCODER_SCRIPT),
            );
            const firstFrame = await read("recording seed frame", () =>
              ServerBrowserPage.captureViewport(tab.page, tab.cdp, {
                format: "jpeg",
                quality: RECORDING_SCREENCAST.quality,
                scale: 1,
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
            opened.on("Page.screencastFrame", (frame) => {
              if (!active) return;
              const cssWidth = tab.page.viewportSize()?.width ?? frame.metadata.deviceWidth;
              const delivered: Promise<void> = openedEncoder
                .evaluate(
                  ([data, width]) =>
                    (globalThis as unknown as EncoderWindow).__t3Recorder.frame(data, width),
                  [frame.data, cssWidth] as const,
                )
                .then(async (accepted) => {
                  if (!accepted) await opened.send("Page.stopScreencast");
                })
                .catch(constVoid)
                .finally(() => {
                  framesInFlight.delete(delivered);
                  void opened
                    .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
                    .catch(constVoid);
                });
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

  // Scaled captures repaint every screencast; pause them to avoid leaking that frame.
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
            throw new ServerBrowserPage.ServerBrowserOperationError(
              "PreviewAutomationRecordingNotActiveError",
              "No recording is active for this tab.",
            );
          }
          let mimeType: string | null;
          const chunks: Array<Buffer> = [];
          try {
            await read("recording screencast stop", () =>
              recording.session.send("Page.stopScreencast"),
            );
            await read("recording final frames", () => Promise.all(recording.framesInFlight));
            await read("recording session detach", () => recording.session.detach());
            const stopped = await read("recording encoder stop", () =>
              recording.encoder.evaluate(() =>
                (globalThis as unknown as EncoderWindow).__t3Recorder.stop(),
              ),
            );
            mimeType = stopped.mimeType;
            // Checked before the transfer so an oversized video never lands in this process.
            if (stopped.bytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
              throw new ServerBrowserPage.ServerBrowserOperationError(
                "PreviewAutomationRecordingTooLargeError",
                "The recording is larger than the attachment limit.",
              );
            }
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
          const data = Buffer.concat(chunks);
          if (!mimeType || data.byteLength === 0) {
            throw new ServerBrowserPage.ServerBrowserOperationError(
              "PreviewAutomationExecutionError",
              "The recording captured no frames.",
            );
          }
          const extension = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
          const pendingId = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${NodeCrypto.randomUUID()}-${extension}`;
          const path = NodePath.join(config.attachmentsDir, `${pendingId}.${extension}`);
          await NodeFSP.mkdir(config.attachmentsDir, { recursive: true });
          await NodeFSP.writeFile(path, data);
          return {
            id: pendingId,
            tabId: tab.tabId,
            path,
            mimeType: mimeType.split(";")[0]!,
            sizeBytes: data.byteLength,
            createdAt: new Date().toISOString(),
            uploadedAttachmentId: pendingId,
          };
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

  const requireTab = async (request: PreviewAutomationRequest) => {
    if (!request.agentSessionId)
      throw new BrowserControlInterrupted("The agent session is missing. Reconnect the provider.");
    const owned = [...tabs.values()].filter(
      (tab) => tab.threadId === request.threadId && tab.control.agentId === request.agentSessionId,
    );
    if (!request.tabIdExplicit && owned.length > 1)
      throw new BrowserControlInterrupted(
        "Multiple tabs belong to this agent session. Pass a tabId from preview_open or preview_status tabs.",
        "tabRequired",
      );
    const tab =
      request.tabId === undefined
        ? latestThreadTab(request.threadId, request.agentSessionId)
        : await Effect.runPromise(
            findTab(request.threadId, request.tabId).pipe(Effect.orElseSucceed(constVoid)),
          );
    if (!tab) {
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationTabNotFoundError",
        "No server preview tab is open for this thread. Call preview_open first.",
      );
    }
    if (!READ_OPERATIONS.has(request.operation) && !tab.control.agentMayAct(request.agentSessionId))
      throw new BrowserControlInterrupted(
        "This tab belongs to another agent session. You can read it, but open your own tab to act.",
        "agentMismatch",
      );
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
    target: { readonly threadId: string; readonly desktopHostId?: string | undefined },
    url: string,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    if (target.desktopHostId === undefined || target.desktopHostId === "local") return url;
    const resolved = await Effect.runPromise(
      desktopChannel.resolveUrl({
        desktopHostId: target.desktopHostId,
        threadId: target.threadId,
        url,
      }),
      { signal },
    );
    signal?.throwIfAborted();
    if (resolved === null)
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationRemoteUnavailableError",
        "The connected desktop cannot resolve this environment URL. Check the environment connection before retrying; the desktop's localhost was not opened.",
      );
    return normalizePreviewUrl(resolved);
  };

  const runOperation = async (
    request: PreviewAutomationRequest,
    signal: AbortSignal,
    remainingTimeoutMs: () => number,
  ): Promise<unknown> => {
    signal.throwIfAborted();
    const input = request.input;
    switch (request.operation) {
      case "status":
        return statusWithTitle(
          request.tabId === undefined
            ? latestThreadTab(request.threadId, request.agentSessionId)
            : tabs.get(tabKey(request.threadId, request.tabId)),
          request.agentSessionId,
        );
      case "profiles": {
        const profiles = await Effect.runPromise(
          desktopChannel.getProfiles({
            threadId: request.threadId,
            agentSessionId: request.agentSessionId ?? "",
          }),
        );
        if (profiles === null)
          throw new ServerBrowserPage.ServerBrowserOperationError(
            "PreviewAutomationRemoteUnavailableError",
            "No unambiguous connected desktop profile catalogue is available. Connect the desktop that owns the desired profile, then call preview_profiles again.",
          );
        return { profiles: profiles.profiles, defaultProfileId: profiles.defaultProfileId };
      }
      case "open":
      case "openWithProfile": {
        if (!request.agentSessionId)
          throw new BrowserControlInterrupted(
            "The agent session is missing. Reconnect the provider.",
          );
        const open = input as PreviewAutomationOpenInput;
        const catalogue = await Effect.runPromise(
          desktopChannel.getProfiles({
            threadId: request.threadId,
            agentSessionId: request.agentSessionId,
          }),
        );
        // Reported web profiles remain available for environment-hosted pages. An
        // explicit desktop-profile operation must still use its owning desktop.
        const useReportedProfile =
          catalogue === null &&
          request.operation === "open" &&
          (reportedProfiles !== null || !desktopChannel.available);
        const reportedProfileId = useReportedProfile
          ? resolveOpenProfile(open.profileId ?? open.profileName)
          : undefined;
        let selectedProfileId: string | undefined;
        if (!useReportedProfile && (open.profileId !== undefined || open.profileName !== undefined)) {
          if (catalogue === null)
            throw new ServerBrowserPage.ServerBrowserOperationError(
              "PreviewAutomationRemoteUnavailableError",
              "The desktop owning the requested browser profile is unavailable or ambiguous. Call preview_profiles after connecting the intended desktop.",
            );
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
            throw new ServerBrowserPage.ServerBrowserOperationError(
              "PreviewAutomationProfileError",
              detail,
              { reason, detail },
            );
          }
          selectedProfileId = matches[0]!.id;
        }
        const newTabProfileId = selectedProfileId ?? catalogue?.defaultProfileId ?? reportedProfileId;
        let url = open.url === undefined ? undefined : normalizePreviewUrl(open.url);
        const reuse = open.reuseExistingTab ?? true;
        if (
          reuse &&
          !request.tabIdExplicit &&
          [...tabs.values()].filter(
            (tab) =>
              tab.threadId === request.threadId && tab.control.agentId === request.agentSessionId,
          ).length > 1
        )
          throw new BrowserControlInterrupted(
            "Multiple tabs are open. Pass tabId or reuseExistingTab=false.",
            "tabRequired",
          );

        const found =
          reuse && request.tabId !== undefined
            ? await Effect.runPromise(
                findTab(request.threadId, request.tabId).pipe(
                  Effect.catchTags({
                    ServerBrowserTabNotFoundError: () => Effect.succeed(undefined),
                  }),
                ),
              )
            : undefined;
        if (reuse && request.tabIdExplicit && !found) {
          const { sessions } = await Effect.runPromise(
            manager.list({ threadId: ThreadId.make(request.threadId) }),
          );
          const desktop = sessions.some(
            (session) => session.tabId === request.tabId && session.runtime !== "server",
          );
          throw new ServerBrowserPage.ServerBrowserOperationError(
            desktop ? "PreviewAutomationExecutionError" : "PreviewAutomationTabNotFoundError",
            desktop
              ? "This tab belongs to the desktop runtime. This environment's server browser cannot control desktop tabs. Omit tabId to open a server tab instead."
              : "The requested server preview tab does not exist.",
          );
        }
        // Only an explicit tabId reuses a tab this session did not open; a tab
        // it last read (such as the user's) is not taken over implicitly.
        let existing =
          found && (request.tabIdExplicit || found.control.agentId === request.agentSessionId)
            ? found
            : undefined;
        if (selectedProfileId !== undefined && request.tabIdExplicit && existing === undefined) {
          throw new ServerBrowserPage.ServerBrowserOperationError(
            "PreviewAutomationTabNotFoundError",
            "The requested preview tab no longer exists.",
          );
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
            throw new ServerBrowserPage.ServerBrowserOperationError(
              "PreviewAutomationProfileError",
              detail,
              { reason: "tab-mismatch", detail },
            );
          }
          existing = undefined;
        }
        if (url !== undefined)
          url = await browserNavigationUrl(
            {
              threadId: request.threadId,
              desktopHostId:
                existing?.desktopHostId ??
                (newTabProfileId === undefined ? undefined : catalogue?.desktopHostId),
            },
            url,
          );
        signal.throwIfAborted();
        const navigationTimeout = Math.min(remainingTimeoutMs(), NAVIGATION_TIMEOUT_MS);
        if (!existing) {
          closeIdleAgentTabs();
          assertTabCapacity(request.agentSessionId);
        }
        const tab =
          existing ??
          (await ensureTab(
            await Effect.runPromise(
              manager.open({
                threadId: request.threadId,
                ...(url ? { url } : {}),
                ...(reportedProfileId === undefined ? {} : { profileId: reportedProfileId }),
                runtime: "server",
                reveal: false,
                automationOwner: request.agentSessionId,
                ...(newTabProfileId === undefined || catalogue === null
                  ? {}
                  : { profileId: newTabProfileId, desktopHostId: catalogue.desktopHostId }),
              }),
            ),
          ));
        signal.throwIfAborted();
        if (existing?.dialog)
          throw new BrowserControlInterrupted(
            "A browser dialog is pending. Read preview_status and use preview_dialog first.",
            "dialogPending",
          );
        return tab.control.agent(
          request.agentSessionId!,
          () =>
            withNativeSurface(tab, signal, remainingTimeoutMs, async () => {
              if (tab.dialog)
                throw new BrowserControlInterrupted(
                  "A browser dialog is pending. Read preview_status and use preview_dialog first.",
                  "dialogPending",
                );
              const reveal = open.open ?? open.show;
              if (reveal !== false) {
                tab.revealRequested = true;
                await Effect.runPromise(
                  manager.requestReveal({
                    threadId: tab.threadId,
                    tabId: tab.tabId,
                    force: reveal === true,
                  }),
                );
              }
              if (existing) {
                if (url) await navigate(tab, url, "load", navigationTimeout);
              } else {
                await tab.initialNavigation;
                signal.throwIfAborted();
              }
              if (!existing && url) {
                await tab.page
                  .waitForLoadState("load", { timeout: navigationTimeout })
                  .catch(constVoid);
              }
              return statusWithTitle(tab, request.agentSessionId);
            }),
          signal,
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
          throw new BrowserControlInterrupted(
            "Multiple tabs belong to this agent session. Pass a tabId from preview_open or preview_status tabs.",
            "tabRequired",
          );
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
          throw new ServerBrowserPage.ServerBrowserOperationError(
            "PreviewAutomationRecordingNotActiveError",
            "No recording is active for this thread.",
          );
        }
        return tab.control.agent(
          request.agentSessionId ?? "",
          () =>
            withNativeSurface(tab, signal, remainingTimeoutMs, (_viewport, releaseSurface) =>
              stopRecording(tab, signal, remainingTimeoutMs, releaseSurface),
            ),
          signal,
        );
      }
    }
    const tab = await requireTab(request);
    signal.throwIfAborted();
    // Closing must unblock an action waiting on a dialog, without queueing behind it.
    if (request.operation === "close") {
      if (tab.control.agentId !== request.agentSessionId)
        throw new BrowserControlInterrupted(
          "Only the agent session that opened this tab can close it.",
          "agentMismatch",
        );
      if (tab.control.controller !== null)
        throw new BrowserControlInterrupted("A human controls this tab.", "humanControl");
      await Effect.runPromise(manager.close({ threadId: tab.threadId, tabId: tab.tabId }));
      void tab.control.close().catch(constVoid);
      dropTab(tab, false);
      return {};
    }
    // A click can be waiting for its dialog. Resolve it outside the serial queue,
    // with the same owner check, so the operation can finish and control can drain.
    if (request.operation === "dialog") {
      if (tab.control.controller !== null)
        throw new BrowserControlInterrupted("A human controls this tab.", "humanControl");
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
          throw new BrowserControlInterrupted(
            "A browser dialog is pending. Read preview_status.",
            "dialogPending",
          );
        return withNativeSurface(tab, signal, remainingTimeoutMs, (_viewport, releaseSurface) =>
          executeTabOperation(tab, request, signal, remainingTimeoutMs, releaseSurface),
        );
      });
    }
    return tab.control.agent(
      agentSessionId,
      () =>
        withNativeSurface(tab, signal, remainingTimeoutMs, async (_viewport, releaseSurface) => {
          if (tab.dialog)
            throw new BrowserControlInterrupted(
              "A browser dialog is pending. Read preview_status and use preview_dialog first.",
              "dialogPending",
            );
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
    );
  };

  const desktopKey = (tab: ServerTab) => ({
    threadId: tab.threadId,
    tabId: tab.tabId,
    ...(tab.desktopHostId === undefined ? {} : { desktopHostId: tab.desktopHostId }),
  });

  /** Native layout and captures need an on-window guest even when no thread shows it. */
  const withNativeSurface = async <A>(
    tab: ServerTab,
    signal: AbortSignal,
    remainingTimeoutMs: () => number,
    operation: (
      viewport?: { readonly width: number; readonly height: number } | null,
      releaseSurface?: () => Promise<void>,
    ) => Promise<A>,
    viewport?: PreviewViewportSetting,
  ): Promise<A> => {
    signal.throwIfAborted();
    if (!tab.desktop) return operation();
    const key = desktopKey(tab);
    const leaseId = NodeCrypto.randomUUID();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await Effect.runPromise(
        desktopChannel
          .surface(key, { action: "release", leaseId }, Math.min(500, remainingTimeoutMs()))
          .pipe(Effect.ignore),
      );
    };
    try {
      const appliedViewport = await Effect.runPromise(
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
    if (!tab.desktop) return async () => {};
    const key = desktopKey(tab);
    const leaseId = NodeCrypto.randomUUID();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await Effect.runPromise(
        desktopChannel
          .surface(key, { action: "release", leaseId }, Math.min(100, options.timeoutMs ?? 100))
          .pipe(Effect.ignore),
      );
    };
    try {
      await Effect.runPromise(
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
          const url = await browserNavigationUrl(tab, resolveNavigationUrl(navigateInput), signal);
          signal.throwIfAborted();
          return navigate(
            tab,
            url,
            navigateInput.readiness ?? "load",
            Math.min(originalInput.timeoutMs ?? request.timeoutMs, remainingTimeoutMs()),
          );
        });
        return statusWithTitle(tab, request.agentSessionId);
      }
      case "resize": {
        const setting = resolvePreviewViewport(input as PreviewAutomationResizeInput);
        await Effect.runPromise(
          manager.resize({ threadId: tab.threadId, tabId: tab.tabId, viewport: setting }),
        );
        await applySetting(tab, setting);
        const viewport = tab.desktop
          ? await withNativeSurface(
              tab,
              signal,
              remainingTimeoutMs,
              async (applied) => applied ?? ServerBrowserPage.viewportSize(tab.page, tab.cdp),
              setting,
            )
          : (tab.page.viewportSize() ?? UNATTACHED_FILL_VIEWPORT);
        return {
          tabId: tab.tabId,
          setting,
          viewport,
        };
      }
      case "setColorScheme": {
        const { colorScheme } = input as PreviewAutomationSetColorSchemeInput;
        const snapshot = await Effect.runPromise(
          manager.adjust({ threadId: tab.threadId, tabId: tab.tabId, colorScheme }),
        );
        await applyRendering(tab, snapshot);
        return { tabId: tab.tabId, colorScheme };
      }
      case "snapshot": {
        const includeImage = (input as { readonly includeImage?: boolean }).includeImage !== false;
        const capture = () =>
          ServerBrowserPage.snapshot({
            ...tab,
            renderScale: RENDER_SCALE,
            includeImage,
            signal,
            timeoutMs: remainingTimeoutMs(),
          });
        return includeImage
          ? withScreencastsPaused(tab, capture, signal, remainingTimeoutMs, releaseRequestSurface)
          : capture();
      }
      case "click": {
        const clickInput = input as PreviewAutomationClickInput;
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

  const handleRequest = (connectionId: string, request: PreviewAutomationRequest) =>
    Clock.clockWith((clock) => {
      const timeoutMs = Math.max(1, request.timeoutMs - Math.min(500, request.timeoutMs / 10));
      const started = clock.monotonicTimeNanosUnsafe();
      const remainingTimeoutMs = () =>
        Math.max(1, timeoutMs - Number(clock.monotonicTimeNanosUnsafe() - started) / 1_000_000);
      return Effect.tryPromise({
        try: (signal) =>
          runOperation(request, signal, remainingTimeoutMs).finally(() => markUsed(request)),
        catch: (cause) =>
          isDesktopBrowserTransportError(cause)
            ? new ServerBrowserPage.ServerBrowserOperationError(
                "PreviewAutomationRemoteUnavailableError",
                cause.message,
                { reason: cause.reason },
              )
            : ServerBrowserPage.toOperationError(cause),
      }).pipe(
        Effect.timeout(timeoutMs),
        Effect.catchTags({
          TimeoutError: () =>
            Effect.fail(
              new ServerBrowserPage.ServerBrowserOperationError(
                "PreviewAutomationTimeoutError",
                "The browser operation exceeded its execution deadline.",
              ),
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
      if (event.type === "opened" && event.snapshot.runtime === "server") {
        await ensureTab(event.snapshot).catch(constVoid);
        return;
      }
      const key = tabKey(event.threadId, event.tabId);
      const tab = tabs.get(key);
      if (event.type === "closed") {
        const popup = nativePopupForTab(event.threadId, event.tabId);
        if (popup) {
          popup.closeRequested = true;
        }
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
        await tab.control
          .system(async () => {
            if (
              !viewportSettingsEqual(event.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT, tab.setting)
            ) {
              await applySetting(tab, event.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT);
            }
            await applyRendering(tab, event.snapshot);
            const request = event.request;
            if (request?.clear === "cookies") await tab.cdp.send("Network.clearBrowserCookies");
            if (request?.clear === "cache") await tab.cdp.send("Network.clearBrowserCache");
            if (request?.hardReload) await tab.cdp.send("Page.reload", { ignoreCache: true });
          })
          .catch((cause: unknown) =>
            runFork(Effect.logWarning("server preview could not apply a tab setting", { cause })),
          );
      }
    });

  const releaseViewerInput = async (viewer: ViewerState, session: CDPSession) => {
    for (const { key, code } of viewer.pressedKeys.values()) {
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code }).catch(constVoid);
    }
    viewer.pressedKeys.clear();
    for (const [button, point] of viewer.pressedButtons) {
      await session
        .send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button,
          ...point,
          buttons: 0,
          clickCount: 1,
        })
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
        await session.send("Input.dispatchMouseEvent", {
          type,
          x: num(message.x),
          y: num(message.y),
          button,
          buttons: num(message.buttons),
          clickCount: num(message.clickCount, type === "mouseMoved" ? 0 : 1),
          modifiers,
        });
        if (button !== "none") {
          if (action === "down")
            viewer.pressedButtons.set(button, { x: num(message.x), y: num(message.y) });
          else if (action === "up") viewer.pressedButtons.delete(button);
        }
        return;
      }
      case "wheel":
        viewer.scrolledAt = Date.now();
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: num(message.x),
          y: num(message.y),
          deltaX: num(message.deltaX),
          deltaY: num(message.deltaY),
          modifiers,
        });
        return;
      case "key": {
        const key = typeof message.key === "string" ? message.key : "";
        const code = typeof message.code === "string" ? message.code : "";
        const text = typeof message.text === "string" ? message.text : undefined;
        if (message.action === "up") {
          await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
          viewer.pressedKeys.delete(code || key);
          return;
        }
        const command = editingCommand(key, modifiers);
        const copying =
          !tab.desktop && (command?.commands[0] === "copy" || command?.commands[0] === "cut");

        if (copying) await takeCopiedText(tab);
        await session.send("Input.dispatchKeyEvent", {
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
        });
        viewer.pressedKeys.set(code || key, { key, code });
        if (copying) {
          const copied = await takeCopiedText(tab);
          if (copied) viewer.push({ _tag: "clipboard", text: copied });
        }
        return;
      }
      case "text":
        if (typeof message.text === "string" && message.text.length > 0) {
          await session.send("Input.insertText", { text: message.text.slice(0, 10_000) });
        }
        return;
      case "resize": {
        const width = Math.min(Math.round(num(message.width)), 3840);
        const height = Math.min(Math.round(num(message.height)), 2160);
        if (width < 100 || height < 100) return;
        viewer.requestedSize = { width, height, order: ++viewerResizeOrder };
        if (tab.setting._tag !== "fill" || tab.desktop) return;
        const current = tab.page.viewportSize();
        if (current?.width === width && current.height === height) return;
        await tab.page.setViewportSize({ width, height });
        broadcastViewport(tab);
        return;
      }
      case "viewport": {
        const setting = decodeViewportSetting(message.setting);
        await Effect.runPromise(
          manager.resize({ threadId: tab.threadId, tabId: tab.tabId, viewport: setting }),
        );
        await applySetting(tab, setting);
        return;
      }
      // A stalled navigation must not block a corrected URL or further viewer input.
      case "navigate":
        if (typeof message.url === "string") {
          const url = await browserNavigationUrl(tab, normalizePreviewUrl(message.url));
          tab.control.trackUntilHandoff(tab.page.goto(url, VIEWER_NAVIGATION_OPTIONS));
        }
        return;
      case "history":
        tab.control.trackUntilHandoff(
          num(message.delta) < 0
            ? tab.page.goBack(VIEWER_NAVIGATION_OPTIONS)
            : tab.page.goForward(VIEWER_NAVIGATION_OPTIONS),
        );
        return;
      case "reload":
        if (message.ignoreCache === true) {
          await session.send("Page.reload", { ignoreCache: true });
          return;
        }
        tab.control.trackUntilHandoff(tab.page.reload(VIEWER_NAVIGATION_OPTIONS));
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

  const attachViewer: ServerBrowser["Service"]["attachViewer"] = (input) =>
    Effect.gen(function* () {
      const tab = yield* findTab(input.threadId, input.tabId);
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => acquirePersistentNativeSurface(tab),
          catch: (cause) => new ServerBrowserLaunchError({ cause }),
        }),
        (release) => Effect.promise(release),
      );
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
          // State a stalled viewer cannot miss replaces its backlog. It runs
          // synchronously so an older replacement can never land after a newer one.
          else if (next._tag === "gone" || next._tag === "control" || next._tag === "fileChooser") {
            const dropped = Effect.runSyncExit(Queue.clear(output));
            if (dropped._tag === "Failure") return;
            Queue.offerUnsafe(output, next);

            const chooser = next._tag === "control" ? fileChooserMessage(tab) : null;
            if (chooser && tab.control.controller === viewer.id) Queue.offerUnsafe(output, chooser);
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
          reportLiveTabs();
        }),
        () =>
          Effect.promise(async () => {
            await tab.control.disconnect(viewer.id, () => releaseViewerInput(viewer, session));
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
      // Full scale: a scaled capture would flash in every other viewer.
      const pushStill = async () => {
        const data = await withCaptureLock(tab, () =>
          ServerBrowserPage.captureViewport(tab.page, session, {
            format: "jpeg",
            quality,
            scale: 1,
          }),
        ).catch(() => null);
        if (data)
          viewer.push({ _tag: "frame", data: Buffer.from(data, "base64"), ack: Effect.void });
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
      broadcastViewport(tab);
      yield* Effect.promise(() => startScreencast(1));
      // An idle page does not repaint for a new screencast, so the viewer
      // starts from a still unless a live frame beat it.
      if (!screencastStarted) yield* Effect.promise(pushStill);
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
                pushFileChooser(tab);
              } else if (message.type === "releaseControl") {
                const releasing = tab.control.release(viewer.id, () =>
                  releaseViewerInput(viewer, session),
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
                await tab.control.human(viewer.id, () =>
                  dispatchViewerInput(tab, session, viewer, message),
                );
              }
            } catch {
              broadcastControl(tab);
            }
          }),
      } satisfies ServerBrowserViewer;
    });

  yield* manager.events.pipe(Stream.runForEach(mirrorManagerEvent), Effect.forkScoped);
  yield* desktopChannel.connectedHosts.pipe(
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
      Effect.sync(() => {
        const tab = tabs.get(tabKey(key.threadId, key.tabId));
        if (tab?.desktop && (tab.desktopHostId ?? "local") === (key.desktopHostId ?? "local"))
          dropTab(tab, false);
      }),
    ),
    Effect.forkScoped,
  );
  yield* desktopChannel.presentations.pipe(
    Stream.runForEach((key) =>
      Effect.sync(() => {
        const tab = tabs.get(tabKey(key.threadId, key.tabId));
        if (!tab?.desktop || tab.desktopHostId !== key.desktopHostId) return;
        tab.nativePresented = desktopChannel.isPresented(key);
        if (tab.nativePresented) tab.revealRequested = false;
        reportLiveTabs();
      }),
    ),
    Effect.forkScoped,
  );
  // The page came back, for example after its DevTools closed. Reconnect now
  // rather than on the next viewer or agent, or the tab's URL and title stop
  // reaching every client in the meantime.
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
  yield* Effect.sync(closeIdleAgentTabs).pipe(
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
      await contexts.close();
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
    reportProfiles,
    openDownload,
    answerFileChooser,
  });
});

export const layer = Layer.effect(ServerBrowser, make);
