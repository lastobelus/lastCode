import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ChatFileAttachment, type ScopedThreadRef } from "@t3tools/contracts";
import { isWindowsAbsolutePath, normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "~/lib/storage";

export type HandoffTarget =
  | { kind: "file"; path: string; line?: number }
  | { kind: "url"; url: string }
  | { kind: "attachment"; attachment: ChatFileAttachment }
  | {
      kind: "pull-request";
      projectId: string;
      repository: string;
      number: number;
      host?: string;
      url?: string;
      environmentId?: string;
    };

export interface HandoffEntry {
  id: string;
  target: HandoffTarget;
  markdownLabel?: string;
  title?: string;
  lastOpenedAt: number;
  sequence: number;
}

const decodeAttachment = Schema.decodeUnknownSync(ChatFileAttachment);
const EMPTY_HANDOFFS: readonly HandoffEntry[] = [];
const cleanText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Resolve authored paths lexically on the environment's platform, never the client's. */
export function resolveHandoffFilePath(path: string, cwd?: string): string | null {
  const windows =
    isWindowsAbsolutePath(path) ||
    path.startsWith("//") ||
    (!!cwd && (isWindowsAbsolutePath(cwd) || cwd.startsWith("//")));
  let absolute = windows ? path.replaceAll("\\", "/") : path;
  if (!absolute.startsWith("/") && !/^[a-z]:\//i.test(absolute)) {
    if (!cwd) return null;
    absolute = `${windows ? cwd.replaceAll("\\", "/") : cwd}/${absolute}`;
  }
  const prefix = windows ? /^(?:[a-z]:\/|\/\/[^/]+\/[^/]+(?:\/|$))/i.exec(absolute)?.[0] : "/";
  if (!prefix) return null;
  const parts: string[] = [];
  for (const part of absolute.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${prefix.replace(/\/$/, "")}/${parts.join("/")}`;
}

function normalizedUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = url.password = "";
    return url.href;
  } catch {
    return undefined;
  }
}

export function handoffUrlsEqual(left: string, right: string): boolean {
  return (normalizedUrl(left) ?? left) === (normalizedUrl(right) ?? right);
}

export function handoffTargetKey(target: HandoffTarget): string {
  switch (target.kind) {
    case "file":
      return `file:${normalizeProjectPathForComparison(target.path.startsWith("//") ? target.path.replaceAll("/", "\\") : target.path)}`;
    case "url":
      return `url:${normalizedUrl(target.url) ?? target.url}`;
    case "attachment":
      return `attachment:${target.attachment.id}`;
    case "pull-request":
      return `pull-request:${target.environmentId ?? ""}:${target.host ?? ""}:${target.repository.toLowerCase()}:${target.number}`;
  }
}

export function handoffDestination(entry: HandoffEntry): string {
  const target = entry.target;
  switch (target.kind) {
    case "file":
      return target.path;
    case "url":
      return target.url;
    case "attachment":
      return target.attachment.name;
    case "pull-request":
      return target.url ?? `${target.host ?? ""}/${target.repository}#${target.number}`;
  }
}

export function handoffTitle(entry: HandoffEntry): string {
  return (
    entry.markdownLabel ??
    entry.title ??
    (entry.target.kind === "file"
      ? entry.target.path.split(/[\\/]/).at(-1) || entry.target.path
      : handoffDestination(entry))
  );
}

export function upsertHandoff(
  entries: readonly HandoffEntry[],
  target: HandoffTarget,
  options: { label?: string; title?: string; at?: number } = {},
): HandoffEntry[] {
  const id = handoffTargetKey(target);
  const existing = entries.find((entry) => entry.id === id);
  const entry: HandoffEntry = {
    id,
    target,
    ...(existing?.markdownLabel ? { markdownLabel: existing.markdownLabel } : {}),
    ...(existing?.title ? { title: existing.title } : {}),
    ...(cleanText(options.label) ? { markdownLabel: cleanText(options.label)! } : {}),
    ...(cleanText(options.title) ? { title: cleanText(options.title)! } : {}),
    lastOpenedAt: options.at ?? Date.now(),
    sequence: entries.reduce((maximum, item) => Math.max(maximum, item.sequence), 0) + 1,
  };
  return [entry, ...entries.filter((item) => item.id !== id)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeTarget(value: unknown): HandoffTarget | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.kind) {
    case "file": {
      if (typeof value.path !== "string") return undefined;
      const path = resolveHandoffFilePath(value.path);
      if (!path) return undefined;
      return {
        kind: "file",
        path,
        ...(typeof value.line === "number" && Number.isSafeInteger(value.line) && value.line > 0
          ? { line: value.line }
          : {}),
      };
    }
    case "url": {
      const url = typeof value.url === "string" ? normalizedUrl(value.url) : undefined;
      return url ? { kind: "url", url } : undefined;
    }
    case "attachment": {
      try {
        return {
          kind: "attachment",
          attachment: decodeAttachment(value.attachment),
        };
      } catch {
        return undefined;
      }
    }
    case "pull-request": {
      if (
        !cleanText(value.projectId) ||
        !cleanText(value.repository) ||
        typeof value.number !== "number" ||
        !Number.isSafeInteger(value.number) ||
        value.number <= 0
      )
        return undefined;
      return {
        kind: "pull-request",
        projectId: value.projectId as string,
        repository: value.repository as string,
        number: value.number,
        ...(cleanText(value.host) ? { host: cleanText(value.host)! } : {}),
        ...(cleanText(value.environmentId)
          ? { environmentId: cleanText(value.environmentId)! }
          : {}),
        ...(typeof value.url === "string" && normalizedUrl(value.url)
          ? { url: normalizedUrl(value.url)! }
          : {}),
      };
    }
  }
  return undefined;
}

export function sanitizeHandoffsState(value: unknown): Record<string, HandoffEntry[]> {
  const result: Record<string, HandoffEntry[]> = {};
  if (!isRecord(value) || !isRecord(value.byThreadKey)) return result;
  for (const [key, items] of Object.entries(value.byThreadKey)) {
    if (!Array.isArray(items)) continue;
    const entries: HandoffEntry[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (!isRecord(item)) continue;
      const target = decodeTarget(item.target);
      if (
        !target ||
        typeof item.lastOpenedAt !== "number" ||
        !Number.isFinite(item.lastOpenedAt) ||
        typeof item.sequence !== "number" ||
        !Number.isSafeInteger(item.sequence) ||
        item.sequence < 0
      )
        continue;
      const id = handoffTargetKey(target);
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id,
        target,
        lastOpenedAt: item.lastOpenedAt,
        sequence: item.sequence,
        ...(cleanText(item.markdownLabel) ? { markdownLabel: cleanText(item.markdownLabel)! } : {}),
        ...(cleanText(item.title) ? { title: cleanText(item.title)! } : {}),
      });
    }
    result[key] = entries.sort((a, b) => b.sequence - a.sequence);
  }
  return result;
}

interface HandoffsState {
  byThreadKey: Record<string, readonly HandoffEntry[]>;
}

// Failures must not turn a successful file open into an exception. Keep the current
// session usable and report persistence failures in diagnostics.
const storage = createJSONStorage(() => {
  let browserStorage: Storage | undefined;
  try {
    browserStorage = typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    /* Storage may be blocked by the client. */
  }
  const base = resolveStorage(browserStorage);
  return {
    getItem: (key: string) => {
      try {
        return base.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key: string, value: string) => {
      try {
        base.setItem(key, value);
      } catch (error) {
        console.warn("Handoffs could not be saved on this client.", error);
      }
    },
    removeItem: (key: string) => {
      try {
        base.removeItem(key);
      } catch {
        /* Preserve current in-memory history. */
      }
    },
  };
});

export const useHandoffsStore = create<HandoffsState>()(
  persist(() => ({ byThreadKey: {} }), {
    name: "lastcode:handoffs:v1",
    version: 1,
    storage,
    merge: (saved, current) => ({ ...current, byThreadKey: sanitizeHandoffsState(saved) }),
  }),
);

export function readThreadHandoffs(ref: ScopedThreadRef): readonly HandoffEntry[] {
  return useHandoffsStore.getState().byThreadKey[scopedThreadKey(ref)] ?? EMPTY_HANDOFFS;
}

export function useThreadHandoffs(ref: ScopedThreadRef | null): readonly HandoffEntry[] {
  const key = ref ? scopedThreadKey(ref) : null;
  return useHandoffsStore((state) =>
    key ? (state.byThreadKey[key] ?? EMPTY_HANDOFFS) : EMPTY_HANDOFFS,
  );
}

export function recordHandoff(
  ref: ScopedThreadRef,
  target: HandoffTarget,
  options: { label?: string; title?: string } = {},
): HandoffEntry {
  const key = scopedThreadKey(ref);
  const entries = upsertHandoff(readThreadHandoffs(ref), target, options);
  useHandoffsStore.setState((state) => ({ byThreadKey: { ...state.byThreadKey, [key]: entries } }));
  return entries[0]!;
}

export function hasFileHandoff(ref: ScopedThreadRef, path: string): boolean {
  return readThreadHandoffs(ref).some(
    (entry) => entry.id === handoffTargetKey({ kind: "file", path }),
  );
}

export function recordKnownFileHandoff(ref: ScopedThreadRef, path: string): void {
  const existing = readThreadHandoffs(ref).find(
    (entry) => entry.id === handoffTargetKey({ kind: "file", path }),
  );
  if (existing) recordHandoff(ref, existing.target);
}

// Only URLs issued by our own file opener acquire provenance. Do not decode tokens.
const browserTargets = new Map<string, { target: HandoffTarget; url: string }>();
const browserKey = (ref: ScopedThreadRef, tabId: string) => `${scopedThreadKey(ref)}:${tabId}`;
export function rememberHandoffBrowser(
  ref: ScopedThreadRef,
  tabId: string,
  target: HandoffTarget,
  url: string,
): void {
  browserTargets.set(browserKey(ref, tabId), { target, url });
}
export function handoffBrowserTarget(ref: ScopedThreadRef, tabId: string) {
  return browserTargets.get(browserKey(ref, tabId));
}
export function resolveKnownHandoffUrl(
  ref: ScopedThreadRef,
  url: string,
): HandoffTarget | undefined {
  const prefix = `${scopedThreadKey(ref)}:`;
  for (const [key, value] of browserTargets)
    if (key.startsWith(prefix) && handoffUrlsEqual(value.url, url)) return value.target;
  return undefined;
}
export function updateHandoffBrowserTitle(
  ref: ScopedThreadRef,
  tabId: string,
  title: string,
  currentUrl?: string,
): void {
  const binding = browserTargets.get(browserKey(ref, tabId));
  if (currentUrl !== undefined && (!binding || !handoffUrlsEqual(binding.url, currentUrl))) return;
  const target = binding?.target;
  if (!target || !cleanText(title)) return;
  const key = scopedThreadKey(ref);
  const id = handoffTargetKey(target);
  const entries = readThreadHandoffs(ref);
  if (!entries.some((entry) => entry.id === id && entry.title !== title)) return;
  useHandoffsStore.setState((state) => ({
    byThreadKey: {
      ...state.byThreadKey,
      [key]: entries.map((entry) => (entry.id === id ? { ...entry, title } : entry)),
    },
  }));
}
