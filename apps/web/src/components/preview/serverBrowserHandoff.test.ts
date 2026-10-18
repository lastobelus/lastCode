import { EnvironmentId, ThreadId, type PreviewSessionSnapshot } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { recordHandoff, readThreadHandoffs, useHandoffsStore } from "~/handoffs/handoffsStore";
import { forgetServerBrowserHandoff, recordServerBrowserHandoff } from "./serverBrowserHandoff";

const settings = vi.hoisted(() => ({ autoShowFloatingPreview: true }));
vi.mock("~/browser/browserDefaults", () => ({ resolveBrowserDefaults: async () => settings }));
const ref = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("background-thread"),
};
const snapshot: PreviewSessionSnapshot = {
  threadId: ref.threadId,
  tabId: "tab-a",
  runtime: "server",
  reveal: true,
  revealRequest: { id: "request-a", force: false },
  navStatus: {
    _tag: "LoadFailed",
    url: "http://localhost:5173/failed",
    title: "",
    code: -1,
    description: "refused",
  },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
};
beforeEach(() => {
  settings.autoShowFloatingPreview = true;
  useHandoffsStore.setState({ byThreadKey: {} });
  forgetServerBrowserHandoff(ref, snapshot.tabId);
});

it("keeps a shown failed URL in its owning background thread without reordering on repeated status", async () => {
  await recordServerBrowserHandoff(ref, snapshot);
  recordHandoff(ref, { kind: "url", url: "https://example.com/newer" });
  await recordServerBrowserHandoff(ref, { ...snapshot, updatedAt: "2026-01-01T00:00:01.000Z" });
  expect(readThreadHandoffs(ref).map((entry) => entry.target)).toEqual([
    { kind: "url", url: "https://example.com/newer" },
    { kind: "url", url: "http://localhost:5173/failed" },
  ]);
  expect(
    readThreadHandoffs({ ...ref, environmentId: EnvironmentId.make("environment-b") }),
  ).toEqual([]);
});

it("honors background-only presentation and accepts a later explicit reveal", async () => {
  settings.autoShowFloatingPreview = false;
  await recordServerBrowserHandoff(ref, snapshot);
  expect(readThreadHandoffs(ref)).toEqual([]);
  await recordServerBrowserHandoff(ref, {
    ...snapshot,
    revealRequest: { id: "forced-reveal", force: true },
  });
  expect(readThreadHandoffs(ref)).toHaveLength(1);
});
