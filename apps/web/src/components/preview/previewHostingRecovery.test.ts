import { EnvironmentId, ThreadId, type PreviewHostingLeaseSummary } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  connection: vi.fn(() => ({ httpBaseUrl: "http://managed-server.example:3773" })),
  list: {},
  recover: {},
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: mocks.run }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("~/state/session", () => ({ readPreparedConnection: mocks.connection }));
vi.mock("~/state/preview", () => ({
  previewEnvironment: { hostingList: mocks.list, hostingRecover: mocks.recover },
}));

import { recoverHostedPreview, selectHostedPreview } from "./previewHostingRecovery";

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
  mocks.connection.mockClear();
});

describe("native preview reopening", () => {
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
      input: { threadId: owner.threadId, leaseId: lease.leaseId, url: lease.url },
    });
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
  it("leaves unmanaged, expired, or failed previews to the existing fallback", async () => {
    mocks.run.mockResolvedValueOnce({ _tag: "Success", value: [] });
    expect(await recoverHostedPreview(owner, "http://localhost:5173/qa")).toBe(false);
    mocks.run
      .mockResolvedValueOnce({ _tag: "Success", value: [lease] })
      .mockResolvedValueOnce({ _tag: "Success", value: null });
    expect(await recoverHostedPreview(owner, "http://localhost:5173/qa")).toBe(false);
    mocks.run.mockResolvedValueOnce({ _tag: "Failure" });
    expect(await recoverHostedPreview(owner, "http://localhost:5173/qa")).toBe(false);
  });
  it("coalesces simultaneous opens and supports a later recovery", async () => {
    let finish!: (value: unknown) => void;
    mocks.run
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ _tag: "Success", value: lease });
    const first = recoverHostedPreview(owner, "http://localhost:5173/qa");
    const second = recoverHostedPreview(owner, "http://localhost:5173/qa");
    expect(second).toBe(first);
    finish({ _tag: "Success", value: [lease] });
    expect(await first).toBe(true);
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
