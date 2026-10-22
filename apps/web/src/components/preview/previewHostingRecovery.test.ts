import {
  EnvironmentId,
  ThreadId,
  PreviewHostingError,
  type PreviewHostingLeaseSummary,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  query: vi.fn(),
  connection: vi.fn(() => ({
    httpBaseUrl: "http://managed-server.example:3773",
    target: {
      _tag: "PrimaryConnectionTarget",
      httpBaseUrl: "http://managed-server.example:3773",
    },
  })),
  configuredEndpoint: vi.fn<() => string | null>(() => null),
  list: {},
  recover: {},
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: mocks.run,
  executeAtomQuery: mocks.query,
}));
vi.mock("~/state/assets", () => ({
  assetEnvironment: { createUrl: (input: unknown) => input },
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("~/state/session", () => ({
  readPreparedConnection: mocks.connection,
  readConfiguredPreviewEnvironmentUrl: () =>
    mocks.configuredEndpoint() ??
    (mocks.connection().target._tag === "PrimaryConnectionTarget"
      ? mocks.connection().target.httpBaseUrl
      : null),
}));
vi.mock("~/state/preview", () => ({
  previewEnvironment: { hostingList: mocks.list, hostingRecover: mocks.recover },
}));

import {
  prepareHostedPreview,
  recoverHostedPreview,
  selectHostedPreview,
} from "./previewHostingRecovery";

const owner = {
  environmentId: EnvironmentId.make("environment-qa"),
  threadId: ThreadId.make("thread-qa"),
};
const lease: PreviewHostingLeaseSummary = {
  leaseId: "lease-qa",
  threadId: owner.threadId,
  url: "http://localhost:5173/qa?version=1#first",
  handedOffAt: "2026-10-02T00:00:00.000Z",
  expiresAt: "2026-10-03T00:00:00.000Z",
  status: "active",
};
beforeEach(() => {
  mocks.run.mockReset();
  mocks.query.mockReset();
  mocks.query.mockResolvedValue({
    _tag: "Success",
    value: { relativeUrl: "/api/assets/resource/report.png", expiresAt: 1790000000000 },
  });
  mocks.connection.mockClear();
  mocks.configuredEndpoint.mockReset();
  mocks.configuredEndpoint.mockReturnValue(null);
});

describe("native preview reopening", () => {
  it("preserves the actionable capacity error when a saved app cannot yet restart", async () => {
    const message =
      "Managed previews are at capacity. Your preview is saved. Close an active Browser view or finish its automation or recording, then retry.";
    mocks.run.mockResolvedValueOnce(AsyncResult.success([lease])).mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new PreviewHostingError({
            reason: "capacity",
            message: "sensitive internal diagnostics",
          }),
        ),
      ),
    );
    await expect(prepareHostedPreview(owner, lease.url)).rejects.toThrow(message);
  });
  it("renews retained signed documents without changing the selected desktop profile", async () => {
    const url = "http://managed-server.example:3773/api/assets/old/report.html?mode=review#chart";
    mocks.query.mockResolvedValue({
      _tag: "Success",
      value: {
        relativeUrl: "/api/assets/fresh/report.html?mode=review#chart",
        expiresAt: 1790000000000,
      },
    });
    expect(await prepareHostedPreview(owner, url, "resource")).toEqual({
      url: "http://managed-server.example:3773/api/assets/fresh/report.html?mode=review#chart",
      managed: false,
      restored: true,
      restarted: true,
    });
    expect(mocks.query.mock.calls[0]?.[1]).toMatchObject({
      input: {
        resource: { _tag: "preview-document", threadId: owner.threadId, url, refresh: false },
      },
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("keeps a healthy document unchanged on return and refreshes access for explicit navigation", async () => {
    const relativeUrl = "/api/assets/current/report.html";
    const url = `http://managed-server.example:3773${relativeUrl}`;
    mocks.query.mockResolvedValue({
      _tag: "Success",
      value: { relativeUrl, expiresAt: 1790000000000 },
    });
    expect(await prepareHostedPreview(owner, url, "resource")).not.toHaveProperty("restarted");
    await prepareHostedPreview(owner, url);
    expect(mocks.query.mock.calls[1]?.[1]).toMatchObject({
      input: { resource: { refresh: true } },
    });
  });

  it("restores the owning lease across remote origin resolution without an agent message", async () => {
    mocks.run
      .mockResolvedValueOnce({ _tag: "Success", value: [lease] })
      .mockResolvedValueOnce({ _tag: "Success", value: lease });
    expect(
      await recoverHostedPreview(owner, "http://managed-server.example:5173/qa?version=1#first"),
    ).toBe(true);
    expect(mocks.run.mock.calls.map((call) => call[1])).toEqual([mocks.list, mocks.recover]);
    expect(mocks.run.mock.calls[1]![2]).toEqual({
      environmentId: owner.environmentId,
      input: { threadId: owner.threadId, leaseId: lease.leaseId, url: lease.url, bootstrap: false },
    });
  });
  it("uses the configured same-environment endpoint for a LAN-to-remote reopen", async () => {
    mocks.connection.mockReturnValue({
      httpBaseUrl: "https://100.100.12.4:8443/",
      target: {
        _tag: "PrimaryConnectionTarget",
        httpBaseUrl: "http://192.168.1.24:3773/",
      },
    });
    mocks.run
      .mockResolvedValueOnce({ _tag: "Success", value: [lease] })
      .mockResolvedValueOnce({ _tag: "Success", value: lease });

    await expect(
      prepareHostedPreview(owner, "http://192.168.1.24:5173/qa?version=1#first"),
    ).resolves.toEqual({
      url: "http://100.100.12.4:5173/qa?version=1#first",
      localUrl: "http://localhost:5173/qa?version=1#first",
      managed: true,
      restored: true,
    });
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
  it("recovers a saved bearer profile URL through its active private endpoint", async () => {
    mocks.connection.mockReturnValue({
      httpBaseUrl: "https://100.100.12.4:8443/",
      target: { _tag: "BearerConnectionTarget", httpBaseUrl: "" },
    });
    mocks.configuredEndpoint.mockReturnValue("http://192.168.1.24:3773/");
    mocks.run
      .mockResolvedValueOnce({ _tag: "Success", value: [lease] })
      .mockResolvedValueOnce({ _tag: "Success", value: lease });
    await expect(
      prepareHostedPreview(owner, "http://192.168.1.24:5173/qa?version=1#first"),
    ).resolves.toEqual({
      url: "http://100.100.12.4:5173/qa?version=1#first",
      localUrl: "http://localhost:5173/qa?version=1#first",
      managed: true,
      restored: true,
    });
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
  it("does not claim arbitrary public pages or another thread's lease", async () => {
    expect(await recoverHostedPreview(owner, "https://public.example:5173/qa")).toBe(false);
    expect(mocks.run).not.toHaveBeenCalled();
    mocks.run.mockResolvedValueOnce({
      _tag: "Success",
      value: [{ ...lease, threadId: ThreadId.make("other-thread") }],
    });
    expect(await recoverHostedPreview(owner, "http://localhost:5173/qa")).toBe(false);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it("leaves unknown links alone and rejects a managed handoff removed during recovery", async () => {
    mocks.run.mockResolvedValueOnce({ _tag: "Success", value: [] });
    expect(await recoverHostedPreview(owner, "http://localhost:5173/qa")).toBe(false);
    mocks.run
      .mockResolvedValueOnce({ _tag: "Success", value: [lease] })
      .mockResolvedValueOnce({ _tag: "Success", value: null });
    await expect(recoverHostedPreview(owner, "http://localhost:5173/qa")).rejects.toThrow(
      "saved preview",
    );
    mocks.run.mockResolvedValueOnce({ _tag: "Failure" });
    expect(await recoverHostedPreview(owner, "http://localhost:5173/qa")).toBe(false);
  });
  it("coalesces simultaneous opens and supports a later recovery", async () => {
    let finish!: (value: unknown) => void;
    let listStarted!: () => void;
    const started = new Promise<void>((resolve) => (listStarted = resolve));
    mocks.run
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
            listStarted();
          }),
      )
      .mockResolvedValue({ _tag: "Success", value: lease });
    const first = recoverHostedPreview(owner, "http://localhost:5173/qa");
    const second = recoverHostedPreview(owner, "http://localhost:5173/qa");
    await started;
    expect(mocks.run).toHaveBeenCalledTimes(1);
    finish({ _tag: "Success", value: [lease] });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    mocks.run.mockResolvedValueOnce({ _tag: "Success", value: [lease] });
    expect(await recoverHostedPreview(owner, "http://localhost:5173/qa")).toBe(true);
    expect(mocks.run).toHaveBeenCalledTimes(4);
  });
  it("retains the server owner for another page while refusing ambiguous ownership", () => {
    expect(selectHostedPreview(new URL("http://localhost:5173/other-page"), [lease])).toEqual(
      lease,
    );
    const another = { ...lease, leaseId: "another", url: "http://localhost:5173/another" };
    expect(
      selectHostedPreview(new URL("http://localhost:5173/unknown"), [lease, another]),
    ).toBeNull();
    expect(
      selectHostedPreview(new URL("http://localhost:5173/qa?version=1"), [lease, another]),
    ).toEqual(lease);
  });
});
