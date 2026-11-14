// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.

import {
  type BrowserRecordingFrameRate,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type PreviewAutomationClickInput,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationDragInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationHoverInput,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationPressInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSelectInput,
  type PreviewAutomationSelectResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationTypeInput,
  type PreviewAutomationUploadInput,
  type PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as Schema from "effect/Schema";
import type { CDPSession, ConsoleMessage, Frame, Locator, Page } from "playwright-core";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import { BrowserControlInterrupted } from "./SessionControl.ts";

const isBrowserControlInterrupted = Schema.is(BrowserControlInterrupted);

const MAX_EVALUATION_BYTES = 64_000;
const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_SCREENSHOT_WIDTH = 1280;
// Two attempts must fit in a snapshot's 10-second deadline.
const SCREENSHOT_TIMEOUT_MS = 3_000;
const WAIT_POLL_MS = 100;
export const DIAGNOSTIC_BUFFER_LIMIT = 200;

export class ServerBrowserOperationError extends Schema.TaggedError<ServerBrowserOperationError>()(
  "ServerBrowserOperationError",
  {
    tag: Schema.String,
    message: Schema.String,
    detail: Schema.optional(Schema.Unknown),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isServerBrowserOperationError = Schema.is(ServerBrowserOperationError);

export const toOperationError = (
  cause: unknown,
  timeoutMs?: number,
): ServerBrowserOperationError => {
  if (isBrowserControlInterrupted(cause))
    return new ServerBrowserOperationError({
      tag: "PreviewAutomationControlInterruptedError",
      message: cause.message,
      detail: cause.reason,
    });
  if (isServerBrowserOperationError(cause)) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  const firstLine = message.split("\n")[0] ?? message;
  if (
    cause instanceof Error &&
    (cause.name === "TimeoutError" ||
      /Desktop browser \S+ exceeded its [\d.]+ms deadline\./.test(message))
  ) {
    return new ServerBrowserOperationError({
      tag: "PreviewAutomationTimeoutError",
      message: withActionabilityReason(firstLine, cause),
      detail: timeoutMs === undefined ? undefined : { timeoutMs },
    });
  }
  if (/while parsing selector|Unknown engine|Unexpected token/i.test(message)) {
    return new ServerBrowserOperationError({
      tag: "PreviewAutomationInvalidSelectorError",
      message: firstLine,
    });
  }
  if (/not an <input>|not editable|not an editable/i.test(message)) {
    return new ServerBrowserOperationError({
      tag: "PreviewAutomationTargetNotEditableError",
      message: firstLine,
    });
  }
  return new ServerBrowserOperationError({
    tag: "PreviewAutomationExecutionError",
    message: firstLine,
  });
};

/** Playwright puts why an element was not actionable in its call log, below the first line. */
const withActionabilityReason = (message: string, cause: Error) => {
  // Playwright dims call-log lines with ANSI escapes when colour is on.
  const reason = NodeUtil.stripVTControlCharacters(cause.message)
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("- element is "))
    ?.slice(2);
  return reason === undefined ? message : `${message} Playwright last saw: ${reason}.`;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const TARGET_COUNT_MS = 250;
const MAX_TARGET_CHARS = 200;
const DEFAULT_READ_TIMEOUT_MS = 10_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 3_000;

type ReadOptions = {
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
};
type ReadStage = <T>(stage: string, operation: (timeoutMs: number) => Promise<T>) => Promise<T>;

/** Shares one deadline across parallel and sequential stages, revoking later stages on expiry. */
export const withReadBudget = async <T>(
  options: ReadOptions,
  operation: (read: ReadStage) => Promise<T>,
  maximumTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
): Promise<T> => {
  const timeoutMs =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.min(options.timeoutMs, maximumTimeoutMs))
      : DEFAULT_READ_TIMEOUT_MS;
  const interrupted = (stage?: string) =>
    isBrowserControlInterrupted(options.signal?.reason)
      ? options.signal.reason
      : new ServerBrowserOperationError({
          tag: "PreviewAutomationControlInterruptedError",
          message:
            stage === undefined
              ? "Browser read was interrupted."
              : `Browser read was interrupted during ${stage}.`,
          detail: stage === undefined ? undefined : { stage },
        });
  // Reject before snapshot setup can revoke the last usable element refs.
  if (options.signal?.aborted) throw interrupted();
  const deadline = Date.now() + timeoutMs;
  const pending = new Set<() => void>();
  let closed = false;
  const read: ReadStage = (stage, start) =>
    new Promise((resolve, reject) => {
      const timedOut = (cause?: unknown) => {
        const error = new ServerBrowserOperationError({
          tag: "PreviewAutomationTimeoutError",
          message: `Browser read timed out after ${timeoutMs}ms during ${stage}.`,
          detail: { stage, timeoutMs },
          cause,
        });
        error.name = "TimeoutError";
        return error;
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        pending.delete(onAbort);
        complete();
      };
      const onAbort = () => finish(() => reject(interrupted(stage)));
      if (closed || options.signal?.aborted) {
        onAbort();
        return;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        finish(() => reject(timedOut()));
        return;
      }
      pending.add(onAbort);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish(() => reject(timedOut())), remainingMs);
      const fail = (cause: unknown) =>
        finish(() =>
          reject(
            Date.now() >= deadline || (cause instanceof Error && cause.name === "TimeoutError")
              ? timedOut(cause)
              : cause,
          ),
        );
      try {
        // CDP and Playwright cannot cancel an individual in-flight call. Keep both
        // handlers attached after expiry, without terminating the shared page.
        start(remainingMs).then(
          (value) => finish(() => (Date.now() >= deadline ? reject(timedOut()) : resolve(value))),
          fail,
        );
      } catch (cause) {
        fail(cause);
      }
    });
  try {
    return await operation(read);
  } finally {
    // A failed parallel stage must also release its siblings' timers/listeners.
    closed = true;
    for (const cancel of pending) cancel();
  }
};

const pageRefs = new WeakMap<Page, { generation: string; refs: Map<string, string> }>();
// A compact runtime namespace prevents old refs from aliasing after a server restart.
const refNamespace = NodeCrypto.randomUUID().slice(0, 8);
let snapshotSequence = 0;
const nextRefGeneration = () => `${refNamespace}-${(++snapshotSequence).toString(36)}`;

/** A takeover revokes previously issued refs even when the document stays unchanged. */
export const invalidateRefs = (page: Page) => {
  const state = pageRefs.get(page);
  if (state) {
    state.generation = nextRefGeneration();
    state.refs.clear();
  }
};

const refsFor = (page: Page) => {
  let state = pageRefs.get(page);
  if (!state) {
    state = { generation: nextRefGeneration(), refs: new Map<string, string>() };
    pageRefs.set(page, state);
    page.on("framenavigated", () => invalidateRefs(page));
    page.on("framedetached", () => invalidateRefs(page));
  }
  return state;
};

const targetLocator = (
  page: Page,
  input: { readonly locator?: string | undefined; readonly selector?: string | undefined },
): Locator | null => {
  const selector = input.locator ?? input.selector;
  if (selector === undefined) return null;
  const engines = selector.replace(
    /\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    " ",
  );
  if (/(?:^|>>)\s*\*?aria-ref\s*=/.test(engines)) {
    const ref = /^\s*aria-ref\s*=\s*(\S+)\s*$/.exec(selector)?.[1];
    const nativeRef = ref === undefined ? undefined : pageRefs.get(page)?.refs.get(ref);
    if (nativeRef === undefined) {
      throw new ServerBrowserOperationError({
        tag: "PreviewAutomationInvalidSelectorError",
        message:
          "This element ref is stale or belongs to another tab. Take a fresh snapshot and use its locator.",
        detail: { staleRef: true },
      });
    }
    return page.locator(`aria-ref=${nativeRef}`);
  }
  // Playwright's strict locators reject ambiguous controls rather than acting on row one.
  return page.locator(selector);
};

export type PointerReporter = (
  point: { readonly x: number; readonly y: number },
  phase: "move" | "click",
) => Promise<void>;
const noPointer: PointerReporter = async () => {};

// Locator.scrollIntoViewIfNeeded resolves its node once and fails when the page replaces it; the
// input actions after it re-resolve, so the scroll does too, within the same timeout.
const DETACHED = /^locator\.scrollIntoViewIfNeeded: Element is not attached to the DOM(?:\n|$)/;

const scrollIntoView = async (locator: Locator, timeout: number) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await locator.scrollIntoViewIfNeeded({ timeout: Math.max(1, deadline - Date.now()) });
    } catch (cause) {
      if (!(cause instanceof Error && DETACHED.test(cause.message)) || Date.now() >= deadline) {
        throw cause;
      }
    }
  }
};

const targetPoint = async (
  page: Page,
  locator: Locator | null,
  input: { readonly x?: number | undefined; readonly y?: number | undefined },
  timeout: () => number,
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  if (locator === null) return { x: input.x ?? 0, y: input.y ?? 0 };
  await scrollIntoView(locator, timeout());
  signal?.throwIfAborted();
  const box = await locator.boundingBox({ timeout: timeout() });
  signal?.throwIfAborted();
  if (box) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const viewport = page.viewportSize();
  return { x: (viewport?.width ?? 0) / 2, y: (viewport?.height ?? 0) / 2 };
};

const SNAPSHOT_SCRIPT = `(() => {
  return {
    url: location.href,
    title: document.title,
    loading: document.readyState !== "complete",
    visibleText: document.body?.innerText || "",
    interactiveElements: [],
  };
})()`;

const MASKED_VALUE = "••••••••";

/**
 * A `data:` URL carries its content, which can be a whole file, and URLs and diagnostics
 * reach tool results and provider logs. Keeps only the media type: the payload can hold any
 * character and parameters are page-chosen too.
 */
export const withoutDataPayload = (url: string) => {
  // Read the scheme as a browser would: it ignores leading controls and spaces, and tabs and
  // newlines anywhere. A snapshot's YAML value may be quoted and escaped; an escape that isn't a
  // tab or newline still decodes to something that can't start a scheme.
  const value = url
    .replace(/^["']/, "")
    .replace(/\\(x[\da-f]{2}|u[\da-f]{4}|.)/gi, (_escape, code: string) =>
      code.length > 1
        ? String.fromCharCode(Number.parseInt(code.slice(1), 16))
        : ({ t: "\t", n: "\n", r: "\r", '"': '"', "\\": "\\" }[code] ?? "\u0001"),
    )
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\u0000-\u0020]+/, "");
  const parsed = /^data:([^,;]*)/i.exec(value);
  if (!parsed) return url;
  const type = parsed[1]!.trim();
  const mediaType = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/.test(type) ? type : "";
  return `data:${mediaType},…`;
};

/**
 * Chromium's own console messages, which carry no arguments, quote `data:` URLs whole, as in a
 * blocked navigation or a CSP violation. Everything after the first one goes, since Chromium
 * accepts any type and a payload can hold any character. What a page logs itself is its own
 * text, like anything else it shows, so it stays.
 */
export const consoleText = (message: ConsoleMessage) =>
  message.args().length > 0
    ? message.text()
    : message.text().replace(/(?<![a-z\d])data:[^,;]*[,;][\s\S]*/i, withoutDataPayload);

// Split on LF alone: a value keeps any U+2028 that a multiline regex would treat as a line end.
const withoutTreeDataPayloads = (tree: string) =>
  tree
    .split("\n")
    .map((line) => {
      const url = /^(\s*- \/url: )(.*)$/s.exec(line);
      return url ? url[1] + withoutDataPayload(url[2]!) : line;
    })
    .join("\n");

// The broker waits 15s for the host; a snapshot, retry included, answers well before.
const SNAPSHOT_TIMEOUT_MS = 10_000;
const FRAME_ANSWER_MS = 1_000;

// Include password and CSS-masked text in open shadow roots, normalized like accessible text.
const DOTTED_SCRIPT = `(() => {
  const values = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) visit(element.shadowRoot);
      const field = element.localName === "input" || element.localName === "textarea";
      if (!field && !element.isContentEditable) continue;
      const dots = getComputedStyle(element).getPropertyValue("-webkit-text-security");
      if (element.type !== "password" && (dots === "none" || dots === "")) continue;
      // Raw as page text shows it, and normalized as the tree does.
      for (const value of field ? [element.value, element.defaultValue] : [element.textContent ?? ""])
        values.push(value, value.replace(/[\\u200b\\u00ad]/g, "").trim().replace(/\\s+/g, " "));
    }
  };
  visit(document);
  return [...new Set(values.filter((value) => value.trim()))];
})()`;

const pageChanged = () =>
  new ServerBrowserOperationError({
    tag: "PreviewAutomationExecutionError",
    message: "The page changed while capturing its snapshot. Take another snapshot.",
  });

const tooBusy = () =>
  new ServerBrowserOperationError({
    tag: "PreviewAutomationTimeoutError",
    message:
      "The page was too busy to capture a snapshot in time. Wait for it to settle and take another snapshot.",
  });

const VALUE_TOO_LONG = "A password field holds a value too long to hide, so no snapshot was taken.";

/** Reuse one CDP session per out-of-process frame across snapshots. */
const frameSessions = new WeakMap<Frame, Promise<CDPSession>>();

/** Returns undefined on failure or frame timeout. */
const answered = <A>(promise: Promise<A>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), FRAME_ANSWER_MS);
  });
  return Promise.race([promise.catch(() => undefined), late]).finally(() => clearTimeout(timer));
};

/** Isolated worlds prevent spoofing; desktop out-of-process frames use page worlds. Missing own-frame reads or changed frames fail; other missing reads return undefined. */
const openReaders = async (page: Page, cdp: CDPSession) => {
  const frames = page.frames();
  const owners = new Map<Frame, CDPSession | null | undefined>(
    await Promise.all(
      frames.map(async (frame) => {
        if (frame === page.mainFrame()) return [frame, cdp] as const;
        const session = frameSessions.get(frame) ?? page.context().newCDPSession(frame);
        frameSessions.set(frame, session);
        try {
          return [frame, await session] as const;
        } catch (cause) {
          frameSessions.delete(frame);
          // CdpRelay supports only the page; other refusals fall back to the parent session, failing if the frame is absent.
          const desktop = String(cause).includes("Only this preview tab's page can be attached");
          return [frame, desktop ? null : undefined] as const;
        }
      }),
    ),
  );
  const ownerOf = (frame: Frame): CDPSession | null => {
    const owner = owners.get(frame);
    if (owner !== undefined) return owner;
    const parent = frame.parentFrame();
    return parent ? ownerOf(parent) : null;
  };
  const sessionReader = (frame: Frame, session: CDPSession) => {
    const owned = frames.filter((each) => ownerOf(each) === session);
    const open = async () => {
      const { frameTree } = await session.send("Page.getFrameTree");
      const ids = (node: typeof frameTree): Array<string> => [
        node.frame.id,
        ...(node.childFrames ?? []).flatMap(ids),
      ];
      // A frame Playwright knows but this session doesn't would go unread.
      if (ids(frameTree).length !== owned.length) throw pageChanged();
      return Promise.all(
        ids(frameTree).map(async (frameId) => {
          const world = await session.send("Page.createIsolatedWorld", {
            frameId,
            worldName: "t3-preview",
          });
          return world.executionContextId;
        }),
      );
    };
    let contexts: ReturnType<typeof open> | undefined;
    const read = async () => {
      const values = (contexts ??= open()).then((ids) =>
        Promise.all(
          ids.map(async (contextId) => {
            const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
              contextId,
              expression: DOTTED_SCRIPT,
              returnByValue: true,
            });
            if (exceptionDetails) throw pageChanged();
            return result.value as Array<string>;
          }),
        ),
      );
      try {
        return (await values).flat();
      } catch (cause) {
        // The frame may have moved to another process; the next snapshot opens a new session.
        if (session !== cdp) {
          frameSessions.delete(frame);
          void session.detach().catch(constVoid);
        }
        throw cause;
      }
    };
    return { frames: owned, read };
  };
  const readers = [
    sessionReader(page.mainFrame(), cdp),
    ...frames.flatMap((frame) => {
      const owner = owners.get(frame);
      if (owner) return owner === cdp ? [] : [sessionReader(frame, owner)];
      const own = () => frame.evaluate(DOTTED_SCRIPT) as Promise<Array<string>>;
      return ownerOf(frame) === null ? [{ frames: [frame], read: own }] : [];
    }),
  ];
  return {
    readers,
    read: async (before?: ReadonlyArray<unknown>) => {
      const now = page.frames();
      if (now.length !== frames.length || now.some((frame, i) => frame !== frames[i])) {
        throw pageChanged();
      }
      return Promise.all(
        readers.map((reader, i) => {
          if (i === 0) return reader.read().catch(() => Promise.reject(pageChanged()));
          return before && !before[i] ? undefined : answered(reader.read());
        }),
      );
    },
  };
};

/** Short values need word boundaries to avoid masking unrelated text. */
const dottedPattern = (values: ReadonlyArray<string>) => {
  const sources = values
    .flatMap((value) => {
      const json = JSON.stringify(value).slice(1, -1);
      // Playwright writes control characters like JSON does, with \xNN for the unnamed ones.
      const quoted = value.replace(/[\\"\p{Cc}]/gu, (char) =>
        '\\"\b\f\n\r\t'.includes(char)
          ? JSON.stringify(char).slice(1, -1)
          : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
      );
      const forms = [value, json, quoted].flatMap((form) => [form, form.replaceAll("'", "''")]);
      return [...new Set(forms)].map((form) => ({ form, word: value.length < 4 }));
    })
    // Longest first, so a form inside another never leaves the rest showing.
    .toSorted((a, b) => b.form.length - a.form.length)
    .map(({ form, word }) => {
      const literal = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return word ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal;
    });
  if (sources.length === 0) return undefined;
  const pattern = new RegExp(sources.join("|"), "gu");
  try {
    // Force regex compilation for one-byte and two-byte strings now; size errors name every value.
    pattern.test("");
    pattern.test("\u2022");
  } catch {
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationExecutionError",
      message: VALUE_TOO_LONG,
    });
  }
  return pattern;
};

// Playwright single-quotes keys containing ': ' and leaves /.../ names unquoted. Recognize only its attributes so name text cannot spoof them.
const TREE_LINE =
  /^(\s*- '?[^\s"':]+)( "(?:[^"\\]|\\.)*"| \/(?:.*?\/)?)?((?: \[(?:active|checked(?:=mixed)?|disabled|expanded|level=\d+|pressed(?:=mixed)?|selected|ref=(?:f\d+)?e\d+|cursor=pointer|box=-?\d+,-?\d+,\d+,\d+)\])*'?)(:.*)?$/;

/** Preserve roles and attributes so refs work; unquoted /.../ names can make matches cross boundaries. */
const maskTree = (tree: string, dotted: RegExp) =>
  tree
    .split("\n")
    .map((line) => {
      const node = TREE_LINE.exec(line);
      const name = node?.[1]?.length ?? 0;
      const attributes = name + (node?.[2]?.length ?? 0);
      const end = attributes + (node?.[3]?.length ?? 0);
      const kept = (from: number, to: number) => to <= name || (from >= attributes && to <= end);
      return line.replace(dotted, (match: string, offset: number) =>
        kept(offset, offset + match.length) ? match : MASKED_VALUE,
      );
    })
    .join("\n");

/** Chromium sizes the capture, so the reported size is read from the PNG header. */
const pngSize = (base64: string) => {
  const header = Buffer.from(base64.slice(0, 32), "base64");
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
};

/**
 * A page's display ratio and CSS viewport, read in an isolated world since page script can
 * reassign `devicePixelRatio`, `innerWidth`, and `innerHeight` in its own, and its page zoom.
 */
const readPageMetricsWithinBudget = async (cdp: CDPSession, read: ReadStage) => {
  const { frameTree } = await read("page metrics frame tree", () => cdp.send("Page.getFrameTree"));
  const { executionContextId } = await read("page metrics isolated world", () =>
    cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "t3-preview-metrics",
    }),
  );
  let { cssVisualViewport } = await read("Page.getLayoutMetrics", () =>
    cdp.send("Page.getLayoutMetrics"),
  );
  // Desktop zoom applies asynchronously; bracket the CSS metrics to reject a torn read.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const zoom = cssVisualViewport.zoom ?? 1;
    const { result } = await read("page rendering metrics", () =>
      cdp.send("Runtime.evaluate", {
        expression: "({ ratio: devicePixelRatio, width: innerWidth, height: innerHeight })",
        contextId: executionContextId,
        returnByValue: true,
      }),
    );
    ({ cssVisualViewport } = await read("Page.getLayoutMetrics", () =>
      cdp.send("Page.getLayoutMetrics"),
    ));
    if ((cssVisualViewport.zoom ?? 1) === zoom) {
      const { ratio, width, height } = result.value as {
        readonly ratio: number;
        readonly width: number;
        readonly height: number;
      };
      return { ratio, width, height, zoom };
    }
  }
  throw new Error(
    "The page's zoom kept changing while the snapshot read its size. Try the snapshot again.",
  );
};

export const readPageMetrics = (cdp: CDPSession) =>
  withReadBudget({}, (read) => readPageMetricsWithinBudget(cdp, read));

type CaptureOptions = ReadOptions & {
  readonly format: "png" | "jpeg";
  readonly quality?: number;
};

const viewportSizeWithinBudget = async (page: Page, cdp: CDPSession, read: ReadStage) => {
  const viewport = page.viewportSize();
  if (viewport) return viewport;
  const { cssVisualViewport } = await read("Page.getLayoutMetrics", () =>
    cdp.send("Page.getLayoutMetrics"),
  );
  return {
    width: Math.max(1, Math.round(cssVisualViewport.clientWidth)),
    height: Math.max(1, Math.round(cssVisualViewport.clientHeight)),
  };
};

/** CDP-attached pages keep the native viewport, which Playwright represents as null. */
export const viewportSize = (page: Page, cdp: CDPSession) =>
  withReadBudget({}, (read) => viewportSizeWithinBudget(page, cdp, read));

// Never pass a clip scale: Chromium mirrors the top-left of the page into a `backdrop-filter`
// in any capture it shrinks.
const captureViewportWithinBudget = async (
  cdp: CDPSession,
  options: CaptureOptions,
  read: ReadStage,
) => {
  const capture = read("Page.captureScreenshot", () =>
    cdp.send("Page.captureScreenshot", {
      format: options.format,
      ...(options.quality === undefined ? {} : { quality: options.quality }),
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ServerBrowserOperationError({
            tag: "PreviewAutomationExecutionError",
            message:
              "The browser is not producing screenshot frames. For a desktop tab, show or restore the T3 Code window and try again.",
          }),
        ),
      SCREENSHOT_TIMEOUT_MS,
    );
  });
  // Hidden native guests can leave CDP captures pending forever. This deadline also
  // releases a viewer's still-capture lock, which an agent snapshot may be waiting for.
  const { data } = await Promise.race([capture, expired]).finally(() => clearTimeout(timer));
  return data;
};

export const captureFinalRecordingFrame = (
  cdp: CDPSession,
  quality: number,
  options: ReadOptions = {},
) =>
  withReadBudget(
    { ...options, timeoutMs: options.timeoutMs ?? FRAME_ANSWER_MS },
    async (read) => {
      await read("recording final paint", (timeoutMs) =>
        cdp.send("Runtime.evaluate", {
          // Capture the destination of finite transitions, not their initially transparent frame.
          expression: `(async () => {
          const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await paint();
          await Promise.allSettled(document.getAnimations()
            .filter(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity)
            .map(animation => animation.finished));
          await paint();
        })()`,
          awaitPromise: true,
          timeout: timeoutMs,
        }),
      );
      return captureViewportWithinBudget(cdp, { format: "jpeg", quality }, read);
    },
    FRAME_ANSWER_MS,
  ).catch(() => undefined);

/** Runs in the page's own isolated world, as the server has no image library. */
const SHRINK_PNG = `async function (png, width, height) {
  const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  // Namespaced, as an XML document's createElement makes a plain element with no getContext.
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
}`;

const shrinkPng = async (cdp: CDPSession, png: string, scale: number, read: ReadStage) => {
  const size = pngSize(png);
  const { frameTree } = await read("Page.getFrameTree", () => cdp.send("Page.getFrameTree"));
  const { executionContextId } = await read("Page.createIsolatedWorld", () =>
    cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "t3-preview-screenshot",
    }),
  );
  const { result, exceptionDetails } = await read("Runtime.callFunctionOn", () =>
    cdp.send("Runtime.callFunctionOn", {
      functionDeclaration: SHRINK_PNG,
      executionContextId,
      arguments: [
        { value: png },
        { value: Math.round(size.width * scale) },
        { value: Math.round(size.height * scale) },
      ],
      awaitPromise: true,
      returnByValue: true,
    }),
  );
  if (exceptionDetails) throw new Error("The snapshot could not shrink its screenshot.");
  return result.value as string;
};

export const captureViewport = (cdp: CDPSession, options: CaptureOptions) =>
  withReadBudget(
    { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS },
    (read) => captureViewportWithinBudget(cdp, options, read),
  ).catch((cause: unknown) => {
    if (
      options.timeoutMs === undefined &&
      isServerBrowserOperationError(cause) &&
      cause.tag === "PreviewAutomationTimeoutError"
    ) {
      throw new ServerBrowserOperationError({
        tag: "PreviewAutomationExecutionError",
        message:
          "The browser is not producing screenshot frames. For a desktop tab, show or restore the T3 Code window and try again.",
      });
    }
    throw cause;
  });

type SnapshotInput = ReadOptions & {
  readonly page: Page;
  readonly cdp: CDPSession;
  /** Headless pages render at the scale the server set; a desktop page at its display's. */
  readonly renderScale: number | "display";
  readonly fullScreenshot?: boolean | undefined;
  readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>;
  readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>;
  readonly actionTimeline: PreviewAutomationSnapshot["actionTimeline"];
  readonly includeImage?: boolean | undefined;
};

/** The scale a page renders at and its viewport in device-independent pixels. */
const renderingOf = async (input: SnapshotInput, read: ReadStage) => {
  if (input.renderScale !== "display") {
    const viewport = await viewportSizeWithinBudget(input.page, input.cdp, read);
    return { renderScale: input.renderScale, viewport };
  }
  // The display ratio a desktop page reports includes its page zoom, and its sizes are CSS pixels.
  const page = await readPageMetricsWithinBudget(input.cdp, read);
  return {
    renderScale: page.ratio / page.zoom,
    viewport: {
      width: Math.round(page.width * page.zoom),
      height: Math.round(page.height * page.zoom),
    },
  };
};

const capture = async (
  input: SnapshotInput,
  deadline: number,
  read: ReadStage,
): Promise<PreviewAutomationSnapshot> => {
  const { renderScale, viewport } = await renderingOf(input, read);
  // A late metrics reply must not begin a capture after viewers have resumed.
  if (Date.now() >= deadline) throw tooBusy();
  const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / (viewport.width * renderScale));
  const state = refsFor(input.page);
  const {
    readers,
    read: readDotted,
    generation,
  } = await read("snapshot readers", async () => {
    invalidateRefs(input.page);
    const generation = state.generation;
    return { ...(await openReaders(input.page, input.cdp)), generation };
  });
  const before = await read("dotted values before snapshot", () => readDotted());
  // Taken between the reads, so a value that changes during either fails the comparison.
  const pageAndScreenshot = Promise.all([
    read(
      "snapshot metadata",
      () =>
        input.page.evaluate(SNAPSHOT_SCRIPT) as Promise<
          Pick<
            PreviewAutomationSnapshot,
            "url" | "title" | "loading" | "visibleText" | "interactiveElements"
          >
        >,
    ),
    input.includeImage === false
      ? undefined
      : captureViewportWithinBudget(input.cdp, { format: "png" }, read).then(async (full) =>
          scale < 1
            ? {
                data: await shrinkPng(input.cdp, full, scale, read),
                full: input.fullScreenshot ? full : undefined,
              }
            : { data: full, full: undefined },
        ),
  ]);
  const maskedTree = async () => {
    // Leaves time for the second read; a frame that never loads holds the tree until then.
    const tree = await read("accessibility tree", (timeoutMs) =>
      input.page.ariaSnapshot({
        mode: "ai",
        boxes: true,
        timeout: Math.max(1, timeoutMs - Math.min(2_000, timeoutMs / 5)),
      }),
    );
    const after = await read("dotted values after snapshot", () => readDotted(before));
    // A value that changed meanwhile may be in the tree under neither reading.
    if (after.some((values, i) => values && JSON.stringify(values) !== JSON.stringify(before[i])))
      throw pageChanged();
    const dotted = dottedPattern(after.flatMap((values) => values ?? []));
    // Unread frames can expose values only if their content appears in the tree.
    const unread = readers.flatMap((reader, i) => (after[i] ? [] : reader.frames));
    const filled = /^\s*- iframe (?:\[active\] )?\[ref=(\S+?)\].*:$/gm;
    for (const [, ref] of unread.length ? tree.matchAll(filled) : []) {
      const iframe = await read("unread frame element", (timeoutMs) =>
        input.page
          .locator(`aria-ref=${ref}`)
          .elementHandle({ timeout: Math.min(2_000, timeoutMs) }),
      );
      if (!iframe) throw pageChanged();
      const frame = await read("unread frame content", () => iframe.contentFrame());
      void iframe.dispose().catch(constVoid);
      if (frame && unread.includes(frame)) throw tooBusy();
    }
    return { tree, dotted };
  };
  // A metadata or capture failure also releases a stalled tree's budget immediately.
  const [[page, screenshot], { tree, dotted }] = await Promise.all([pageAndScreenshot, maskedTree()]);
  const { data, full } = screenshot ?? {};
  if (Date.now() >= deadline) throw tooBusy();
  if (state.generation !== generation) throw pageChanged();
  const mask = (text: string) => (dotted ? text.replace(dotted, MASKED_VALUE) : text);
  // Redacted before the cut, so a payload crossing it can't leave its start showing, and before
  // masking, which could hide the `data:` scheme behind a password value's dots.
  const redacted = withoutTreeDataPayloads(tree);
  const accessibilityTree = (dotted ? maskTree(redacted, dotted) : redacted)
    .slice(0, MAX_VISIBLE_TEXT_LENGTH)
    .replace(/\[ref=((?:f\d+)?e\d+)\]/g, (_match, nativeRef: string) => {
      const ref = `t3-${generation}-${nativeRef}`;
      state.refs.set(ref, nativeRef);
      return `[ref=${ref}]`;
    });
  return {
    ...page,
    url: withoutDataPayload(page.url),
    // Mask text before truncating so a value crossing the cut cannot leak its prefix.
    visibleText: mask(page.visibleText).slice(0, MAX_VISIBLE_TEXT_LENGTH),
    accessibilityTree,
    consoleEntries: [...input.consoleEntries],
    networkEntries: [...input.networkEntries],
    actionTimeline: [...input.actionTimeline],
    ...(data === undefined
      ? {}
      : {
          screenshot: {
            mimeType: "image/png" as const,
            data,
            ...pngSize(data),
          },
        }),
    ...(full !== undefined ? { fullScreenshot: { data: full, ...pngSize(full) } } : {}),
  };
};

/** Snapshots begun per page; observers' snapshots aren't queued, so two can overlap. */
const snapshotTurns = new WeakMap<Page, number>();

export const snapshot = (input: SnapshotInput): Promise<PreviewAutomationSnapshot> => {
  const timeoutMs =
    input.timeoutMs !== undefined && Number.isFinite(input.timeoutMs)
      ? Math.max(1, Math.min(input.timeoutMs, SNAPSHOT_TIMEOUT_MS))
      : SNAPSHOT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  return withReadBudget(input, async (read) => {
    const turn = (snapshotTurns.get(input.page) ?? 0) + 1;
    snapshotTurns.set(input.page, turn);
    try {
      return await capture(input, deadline, read);
    } catch (cause) {
      // Retry a changing page only while this read still owns its refs and budget.
      // Disconnections and interruptions must immediately release parallel stages.
      if (
        !input.signal?.aborted &&
        Date.now() < deadline &&
        snapshotTurns.get(input.page) === turn &&
        isServerBrowserOperationError(cause) &&
        (cause.message === pageChanged().message || cause.tag === "PreviewAutomationTimeoutError")
      ) {
        return capture(input, deadline, read);
      }
      throw cause;
    }
  });
};

/** Return when a dialog opens; waiting for the action to finish would block until dialog resolution. */
export const click = async (
  page: Page,
  input: PreviewAutomationClickInput,
  pointer: PointerReporter = noPointer,
  signal?: AbortSignal,
): Promise<{ readonly x: number; readonly y: number }> => {
  signal?.throwIfAborted();
  // One deadline across steps keeps the reply inside the broker's grace; Playwright reads 0 as none.
  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const remaining = () => Math.max(1, deadline - Date.now());
  const locator = targetLocator(page, input);
  try {
    return await clickTarget(page, locator, input, remaining, pointer, signal);
  } catch (cause) {
    throw locator === null ? cause : await namedTargetTimeout(locator, input, cause);
  }
};

/**
 * Playwright's timeout names neither the target nor why it waited. Counting only after the
 * wait failed keeps auto-wait intact, but the count describes the page after the timeout, not
 * what the click did: Playwright can dispatch the click and then time out waiting for the
 * navigation it started.
 */
const namedTargetTimeout = async (
  locator: Locator,
  input: { readonly locator?: string | undefined; readonly selector?: string | undefined },
  cause: unknown,
) => {
  if (!(cause instanceof Error && cause.name === "TimeoutError")) return cause;
  const selector = JSON.stringify(input.locator ?? input.selector);
  // The warning leads and the target is capped, so a reply cut short still carries the warning.
  const target =
    selector.length > MAX_TARGET_CHARS ? `${selector.slice(0, MAX_TARGET_CHARS)}...` : selector;
  // The host's reply must still beat the broker's short grace after the operation timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const matches = await Promise.race([
    locator.count().catch(() => undefined),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), TARGET_COUNT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  const reason =
    matches === undefined
      ? `The click may have happened; check the page before retrying. Whether ${target} still matches an element is unknown.`
      : matches === 0
        ? `The click may have happened and removed its target or navigated; check the page before retrying. No element matches ${target} after the timeout; take a fresh snapshot and use its locator.`
        : `The click may have happened; check the page before retrying. ${target} still matches an element after the timeout.`;
  const message = withActionabilityReason(reason, cause);
  return new ServerBrowserOperationError({
    tag: "PreviewAutomationTimeoutError",
    message,
    detail: { reason: message },
    cause,
  });
};

const clickTarget = async (
  page: Page,
  locator: Locator | null,
  input: PreviewAutomationClickInput,
  timeout: () => number,
  pointer: PointerReporter,
  signal?: AbortSignal,
) => {
  const point = await withReadBudget({ timeoutMs: timeout(), signal }, (read) =>
    read("target layout", () => targetPoint(page, locator, input, timeout, signal)),
  );
  await pointer(point, "click");
  signal?.throwIfAborted();
  const options = { button: input.button ?? "left", clickCount: input.clickCount ?? 1 } as const;
  const clicked =
    locator === null
      ? page.mouse.click(point.x, point.y, options)
      : locator.click({ ...options, timeout: timeout() });
  let onDialog = constVoid;
  const dialogOpened = new Promise<"dialog">((resolve) => {
    onDialog = () => resolve("dialog");
    page.once("dialog", onDialog);
  });
  try {
    if ((await Promise.race([clicked, dialogOpened])) === "dialog") void clicked.catch(constVoid);
  } finally {
    page.off("dialog", onDialog);
  }
  return point;
};

export const type = async (page: Page, input: PreviewAutomationTypeInput, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const locator = targetLocator(page, input);
  if (locator !== null && input.clear) {
    await locator.fill(input.text, { timeout });
    return;
  }
  // A shadow host also matches :focus; use its innermost focused descendant.
  const target = locator ?? page.locator("*:focus").last();
  const focused =
    (locator !== null || (await target.count()) > 0) &&
    (await target.evaluate(
      (element) => {
        // Require an enabled, focused text target to avoid losing input or sending it to the previous field.
        const control = element as unknown as {
          readonly type?: string;
          readonly disabled?: boolean;
          readonly readOnly?: boolean;
          readonly isContentEditable?: boolean;
          readonly focus?: () => void;
        };
        const nonText = [
          "button",
          "checkbox",
          "color",
          "file",
          "hidden",
          "image",
          "radio",
          "range",
          "reset",
          "submit",
        ];
        const textControl =
          element.tagName === "TEXTAREA" ||
          (element.tagName === "INPUT" && !nonText.includes(control.type ?? "text"));
        if (!(textControl || control.isContentEditable) || control.disabled || control.readOnly) {
          return false;
        }
        control.focus?.();
        const root = element.getRootNode() as { readonly activeElement?: typeof element | null };
        const active = root.activeElement;
        return active != null && (active === element || element.contains(active));
      },
      undefined,
      { timeout },
    ));
  signal?.throwIfAborted();
  if (focused !== true) {
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationTargetNotEditableError",
      message: "The target is not an enabled text field, so no text was typed.",
    });
  }
  if (input.clear) {
    await page.keyboard.press("ControlOrMeta+A");
    signal?.throwIfAborted();
    await page.keyboard.press("Delete");
  }
  signal?.throwIfAborted();
  await page.keyboard.insertText(input.text);
};

export const hover = async (
  page: Page,
  input: PreviewAutomationHoverInput,
  pointer: PointerReporter = noPointer,
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const locator = targetLocator(page, input);
  await pointer(await targetPoint(page, locator, input, () => timeout, signal), "move");
  signal?.throwIfAborted();
  if (locator === null) {
    await page.mouse.move(input.x ?? 0, input.y ?? 0);
    return;
  }
  await locator.hover({ timeout });
};

export const select = async (
  page: Page,
  input: PreviewAutomationSelectInput,
  signal?: AbortSignal,
): Promise<PreviewAutomationSelectResult> => {
  const locator = targetLocator(page, input)!;
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const options = await locator.evaluate(
    (element) =>
      element.tagName === "SELECT"
        ? Array.from(
            (element as unknown as { options: ArrayLike<{ value: string; label: string }> })
              .options,
            ({ value, label }) => ({ value, label: label.trim() }),
          )
        : null,
    undefined,
    { timeout },
  );
  signal?.throwIfAborted();
  const values =
    options &&
    input.values.map(
      (entry) =>
        (
          options.find((option) => option.value === entry) ??
          options.find((option) => option.label === entry.trim())
        )?.value ?? entry,
    );
  if (values === null)
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationTargetNotEditableError",
      message: "This element is not a <select>. Click a custom dropdown, then click its option.",
    });
  return { selected: await locator.selectOption(values, { timeout }) };
};

export const drag = async (
  page: Page,
  input: PreviewAutomationDragInput,
  pointer: PointerReporter = noPointer,
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const source = targetLocator(page, { locator: input.source })!;
  const target = targetLocator(page, { locator: input.target })!;
  await pointer(await targetPoint(page, source, {}, () => timeout, signal), "move");
  signal?.throwIfAborted();
  // Observe drag rejection immediately; an unhandled rejection during cursor movement exits the server.
  // Chromium delivers a single move before dragstart; steps give the page mousemoves during the drag.
  const dragFailure = source.dragTo(target, { timeout, steps: 5 }).then(
    () => null,
    (error: unknown) => ({ error }),
  );
  const end = await target.boundingBox({ timeout }).catch(() => null);
  if (end) await pointer({ x: end.x + end.width / 2, y: end.y + end.height / 2 }, "move");
  const failure = await dragFailure;
  if (failure) throw failure.error;
};

export const setInputFiles = async (
  page: Page,
  input: PreviewAutomationUploadInput,
  files: Parameters<Locator["setInputFiles"]>[0] = [...input.paths],
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  const locator = targetLocator(page, input);
  if (locator === null) return false;
  await locator.setInputFiles(files, { timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  return true;
};

export const press = async (
  page: Page,
  input: PreviewAutomationPressInput,
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  await page.keyboard.press([...(input.modifiers ?? []), input.key].join("+"));
};

export const scroll = async (
  page: Page,
  input: PreviewAutomationScrollInput,
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  const delta = [input.deltaX ?? 0, input.deltaY ?? 0] as const;
  const locator = targetLocator(page, input);
  if (locator === null) {
    // Page-side code is passed as source: the server compiles without DOM types.
    await page.evaluate(`scrollBy(${delta[0]}, ${delta[1]})`);
    return;
  }
  await locator.evaluate((element, [x, y]) => element.scrollBy(x, y), delta);
};

const UNRESPONSIVE_SCRIPT_PROBE_MS = 1_000;

/**
 * A same-site navigation reuses the renderer, so it never commits while a page script holds it.
 * Call before starting the navigation: Chrome does not deliver a terminate once one is pending.
 */
export const stopUnresponsiveScript = async (cdp: CDPSession, budgetMs = Infinity) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answered = cdp.send("Runtime.evaluate", { expression: "0" }).then(
    () => true,
    () => true,
  );
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.min(budgetMs, UNRESPONSIVE_SCRIPT_PROBE_MS));
  });
  const responsive = await Promise.race([answered, expired]).finally(() => clearTimeout(timer));
  // Not awaited: a renderer blocked on something other than script may never acknowledge it.
  if (!responsive) void cdp.send("Runtime.terminateExecution").catch(constVoid);
};

/** Terminate expired page scripts so a hung expression cannot block the tab's control queue. */
export const evaluate = async (
  cdp: CDPSession,
  input: PreviewAutomationEvaluateInput,
  options: ReadOptions = {},
) => {
  const result = await withReadBudget(
    options,
    async (read) => {
      const params = {
        expression: input.expression,
        awaitPromise: input.awaitPromise ?? true,
        returnByValue: true,
      };
      const classic = await read("Runtime.evaluate", (timeoutMs) =>
        cdp.send("Runtime.evaluate", { ...params, timeout: timeoutMs }),
      );
      // replMode supports top-level await but leaves a trailing promise unawaited.
      // Retry only a parser rejection, which ran nothing; runtime failures must not rerun work.
      const failure = classic.exceptionDetails;
      const unparsed =
        failure?.exception?.className === "SyntaxError" &&
        failure.scriptId !== undefined &&
        failure.stackTrace === undefined;
      return unparsed && input.expression.includes("await")
        ? read("Runtime.evaluate", (timeoutMs) =>
            cdp.send("Runtime.evaluate", { ...params, timeout: timeoutMs, replMode: true }),
          )
        : classic;
    },
    // awaitPromise is deliberate user work; honor the broker's explicit remaining budget.
    Number.POSITIVE_INFINITY,
  ).catch((cause: unknown) => {
    if (
      isServerBrowserOperationError(cause) &&
      cause.tag === "PreviewAutomationTimeoutError"
    )
      void cdp.send("Runtime.terminateExecution").catch(constVoid);
    throw cause;
  });
  if (result.exceptionDetails) {
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationExecutionError",
      message: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    });
  }
  const value =
    "value" in result.result ? result.result.value : (result.result.description ?? null);
  const actualBytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  if (actualBytes > MAX_EVALUATION_BYTES) {
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationResultTooLargeError",
      message: `Evaluation result is ${actualBytes} bytes; the limit is ${MAX_EVALUATION_BYTES}.`,
      detail: { maximumBytes: MAX_EVALUATION_BYTES },
    });
  }
  return value;
};

export const waitFor = async (
  page: Page,
  input: PreviewAutomationWaitForInput,
  options: ReadOptions = {},
) =>
  withReadBudget(
    { ...options, timeoutMs: input.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    async (read) => {
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      const locator = targetLocator(page, input);
      const { text, urlIncludes } = input;
      const checks: Array<() => Promise<boolean>> = [];
      if (locator !== null) checks.push(async () => (await locator.count()) > 0);
      if (text !== undefined) {
        // A navigation can destroy the context mid-check; that counts as not yet.
        checks.push(() =>
          page
            .evaluate(`(document.body?.innerText ?? "").includes(${JSON.stringify(text)})`)
            .then((found) => found === true)
            .catch(() => false),
        );
      }
      if (urlIncludes !== undefined) checks.push(async () => page.url().includes(urlIncludes));
      for (;;) {
        const results = await Promise.all(checks.map((check) => read("wait condition", check)));
        if (results.every(Boolean)) return;
        if (Date.now() >= deadline) {
          throw new ServerBrowserOperationError({
            tag: "PreviewAutomationTimeoutError",
            message: `Waited ${timeoutMs}ms without every condition holding.`,
          });
        }
        await read(
          "wait interval",
          () => new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS)),
        );
      }
    },
    Number.POSITIVE_INFINITY,
  );

const NET_ERROR_CODES: Readonly<Record<string, number>> = {
  ERR_FAILED: -2,
  ERR_TIMED_OUT: -7,
  ERR_CONNECTION_CLOSED: -100,
  ERR_CONNECTION_RESET: -101,
  ERR_CONNECTION_REFUSED: -102,
  ERR_NAME_NOT_RESOLVED: -105,
  ERR_INTERNET_DISCONNECTED: -106,
  ERR_ADDRESS_UNREACHABLE: -109,
  ERR_CERT_AUTHORITY_INVALID: -202,
  ERR_EMPTY_RESPONSE: -324,
};

export const parseNetError = (errorText: string) => {
  // Names can hold digits, as in ERR_HTTP2_PROTOCOL_ERROR.
  const description = /ERR_[A-Z\d_]+/.exec(errorText)?.[0] ?? errorText;
  return { description, code: NET_ERROR_CODES[description] ?? -2 };
};

export const recordingEncoderScript = (frameRate: BrowserRecordingFrameRate) => `(() => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const chunks = [];
  let recorder = null;
  let started = null;
  let stopped = null;
  let sizeBytes = 0;
  let tooLarge = false;
  let frame = null;
  let cursor = null;
  let ring = null;
  const AGENT_CURSOR_PATH = new Path2D("M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z");
  let ringTimer = null;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  const paint = () => {
    if (!frame) return;
    const fit = Math.min(canvas.width / frame.width, canvas.height / frame.height);
    const width = frame.width * fit;
    const height = frame.height * fit;
    offsetX = (canvas.width - width) / 2;
    offsetY = (canvas.height - height) / 2;
    if (width < canvas.width || height < canvas.height) {
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(frame, offsetX, offsetY, width, height);
    scale = (width / frame.width) * frame.cssScale;
    if (ring) {
      const age = (performance.now() - ring.at) / 400;
      if (age < 1) {
        context.beginPath();
        context.arc(offsetX + ring.x * scale, offsetY + ring.y * scale, (8 + 18 * age) * scale, 0, Math.PI * 2);
        context.strokeStyle = "rgba(59,130,246," + (0.9 * (1 - age)) + ")";
        context.lineWidth = 3 * scale;
        context.stroke();
      }
    }
    if (cursor) {
      // The agent cursor (lucide MousePointer2, as in the live panel), never the human arrow.
      const s = 20 / 24 * scale;
      context.save();
      context.translate(offsetX + cursor.x * scale - 2 * scale, offsetY + cursor.y * scale - 2 * scale);
      context.scale(s, s);
      context.lineWidth = 2;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.fillStyle = "#fff";
      context.strokeStyle = "#2563eb";
      context.shadowColor = "rgba(0,0,0,0.25)";
      context.shadowBlur = 2;
      context.fill(AGENT_CURSOR_PATH);
      context.shadowColor = "transparent";
      context.stroke(AGENT_CURSOR_PATH);
      context.restore();
    }
  };
  window.__t3Recorder = {
    async frame(base64, cssWidth) {
      if (tooLarge) return false;
      // A per-character atob copy costs ~30 ms on a 3200x1800 frame and throttles recordings.
      const bytes = Uint8Array.fromBase64(base64);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      if (tooLarge) { bitmap.close(); return false; }
      if (!recorder) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const mimeType = ["video/mp4;codecs=avc1.640033", "video/webm;codecs=vp9", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
        const bitsPerSecond = Math.min(50e6, Math.max(2.5e6, bitmap.width * bitmap.height * ${frameRate} * 0.05));
        recorder = new MediaRecorder(canvas.captureStream(${frameRate}), { mimeType, videoBitsPerSecond: bitsPerSecond });
        started = new Promise((resolve, reject) => {
          recorder.onstart = resolve;
          recorder.onerror = (event) => reject(event.error);
        });
        stopped = new Promise((resolve) => { recorder.onstop = resolve; });
        recorder.ondataavailable = (event) => {
          if (tooLarge || event.data.size === 0) return;
          sizeBytes += event.data.size;
          if (sizeBytes > ${PROVIDER_SEND_TURN_MAX_FILE_BYTES}) {
            tooLarge = true;
            chunks.length = 0;
            clearInterval(ringTimer);
            frame?.close();
            frame = null;
            if (recorder.state !== "inactive") recorder.stop();
            for (const track of recorder.stream.getTracks()) track.stop();
            return;
          }
          chunks.push(event.data);
        };
        recorder.start(1000);
      }
      // Frame px per page CSS px, before fitting into the canvas.
      bitmap.cssScale = bitmap.width / cssWidth;
      frame?.close();
      frame = bitmap;
      paint();
      await started;
      return true;
    },
    cursor(x, y, click) {
      if (tooLarge) return;
      cursor = { x, y };
      if (click) {
        ring = { x, y, at: performance.now() };
        clearInterval(ringTimer);
        ringTimer = setInterval(() => {
          paint();
          if (performance.now() - ring.at > 400) { ring = null; clearInterval(ringTimer); paint(); }
        }, 33);
      }
      paint();
    },
    async stop() {
      if (!recorder) return { mimeType: null, count: 0, bytes: 0 };
      if (recorder.state !== "inactive") {
        // Consume the cached frame, then wait for the final paint to reach the
        // capture stream. Animation ticks alone can stop before it is delivered.
        const video = document.createElement("video");
        video.muted = true;
        video.srcObject = recorder.stream;
        const nextFrame = () => Promise.race([
          new Promise(resolve => video.requestVideoFrameCallback(resolve)),
          stopped,
        ]);
        const initial = nextFrame();
        void video.play().catch(() => {});
        await initial;
        if (recorder.state !== "inactive") {
          const delivered = nextFrame();
          recorder.stream.getVideoTracks()[0].requestFrame();
          paint();
          await delivered;
        }
        video.pause();
        video.srcObject = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      await stopped;
      return { mimeType: recorder.mimeType, count: chunks.length, bytes: sizeBytes };
    },
    async chunk(index) {
      const bytes = new Uint8Array(await chunks[index].arrayBuffer());
      if (typeof bytes.toBase64 === "function") return bytes.toBase64();
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return btoa(binary);
    },
    download() {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
      link.download = "recording";
      link.click();
    },
  };
})()`;
