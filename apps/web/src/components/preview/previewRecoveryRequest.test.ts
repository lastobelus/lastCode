import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearPreviewRecoveryRequest,
  usePreviewRecoveryRequestStore,
  requestPreviewRecovery as requestPreviewRecoveryDirect,
} from "./previewRecoveryRequest";

const io = vi.hoisted(() => ({
  run: vi.fn(),
  claim: vi.fn(),
  shell: null as null | Record<string, unknown>,
  nextId: 0,
}));

vi.mock("@t3tools/client-runtime/state/runtime", async (load) => ({
  ...(await load<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: (...args: unknown[]) =>
    args[1] === "claim-recovery" ? io.claim(...args) : io.run(...args),
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { registry: true } }));
vi.mock("~/state/entities", () => ({ readThreadShell: () => io.shell }));
vi.mock("~/state/threads", () => ({ threadEnvironment: { startTurn: "start-turn" } }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { claimRecovery: "claim-recovery" } }));
vi.mock("~/lib/utils", () => ({
  randomUUID: () => `uuid-${++io.nextId}`,
  newMessageId: () => `message-${++io.nextId}`,
}));

const threadRef = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-a"));
const otherEnvironmentRef = scopeThreadRef(EnvironmentId.make("env-b"), ThreadId.make("thread-a"));
const url = "http://127.0.0.1:4321/preview";

function requestPreviewRecovery(
  input: Parameters<typeof requestPreviewRecoveryDirect>[0],
): Promise<void> {
  return requestPreviewRecoveryDirect({ ...input, tabId: input.tabId ?? "tab-a" });
}

function shell(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-a",
    title: "Preview work",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    archivedAt: null,
    ...overrides,
  };
}

function state(ref = threadRef, requestedUrl = url) {
  const key = JSON.stringify([scopedThreadKey(ref), requestedUrl]);
  const store = usePreviewRecoveryRequestStore.getState();
  return store.byRequestKey[key]?.state ?? { status: "idle" };
}

beforeEach(async () => {
  io.run.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  io.claim.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      commandId: CommandId.make("server-command"),
      messageId: MessageId.make("server-message"),
    },
  });
  io.shell = shell();
  io.nextId = 0;
  await usePreviewRecoveryRequestStore.persist.clearStorage();
  usePreviewRecoveryRequestStore.setState({ byRequestKey: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("preview recovery requests", () => {
  it("sends the failure to the exact thread with its stored modes and browser context", async () => {
    await requestPreviewRecovery({
      threadRef,
      url,
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
      title: "Field examples",
      tabId: "tab-a",
    });

    expect(io.run).toHaveBeenCalledTimes(1);
    expect(io.run.mock.calls[0]).toMatchObject([
      { registry: true },
      "start-turn",
      {
        environmentId: "env-a",
        input: {
          threadId: "thread-a",
          message: {
            role: "user",
            text: expect.stringContaining("Please restore the preview for this thread"),
            attachments: [],
          },
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      },
      { reportFailure: false },
    ]);
    const sentInput = io.run.mock.calls[0]?.[2] as {
      input: { commandId: string; message: { messageId: string; text: string } };
    };
    expect(sentInput.input.commandId).toBe(CommandId.make("server-command"));
    expect(sentInput.input.message.messageId).toBe("server-message");
    expect(sentInput.input.message.text).toContain(url);
    expect(sentInput.input.message.text).toContain("ERR_NAME_NOT_RESOLVED (-105)");
    expect(sentInput.input.message.text).toContain("Field examples");
    expect(sentInput.input.message.text).toContain("tab-a");
    expect(state()).toEqual({ status: "sent" });
  });

  it("deduplicates in-flight and sent requests per scoped thread and exact URL", async () => {
    let finish!: (value: { _tag: "Success"; value: undefined }) => void;
    io.run.mockReturnValue(new Promise((resolve) => (finish = resolve)));

    const first = requestPreviewRecovery({ threadRef, url, code: -105, description: "down" });
    const duplicate = requestPreviewRecovery({
      threadRef,
      url,
      code: -105,
      description: "down again",
    });
    await Promise.resolve();
    expect(io.run).toHaveBeenCalledTimes(1);
    expect(state()).toEqual({ status: "sending" });
    finish({ _tag: "Success", value: undefined });
    await Promise.all([first, duplicate]);

    await requestPreviewRecovery({
      threadRef,
      url,
      code: -105,
      description: "still failed",
    });
    expect(io.run).toHaveBeenCalledTimes(1);

    await requestPreviewRecovery({
      threadRef: otherEnvironmentRef,
      url,
      code: -105,
      description: "different environment",
    });
    await requestPreviewRecovery({
      threadRef,
      url: `${url}?different=1`,
      code: -105,
      description: "different URL",
    });
    expect(io.run).toHaveBeenCalledTimes(3);
  });

  it("keeps the same command and message IDs when retrying a failed dispatch", async () => {
    io.run
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(new Error("Connection was lost before acknowledgement")),
      })
      .mockResolvedValueOnce({ _tag: "Success", value: undefined });

    await requestPreviewRecovery({ threadRef, url, code: -105, description: "down" });
    expect(state()).toEqual({
      status: "error",
      error: "Connection was lost before acknowledgement",
    });
    const failedInput = io.run.mock.calls[0]?.[2] as {
      input: { commandId: string; message: { messageId: string; text: string } };
    };

    await requestPreviewRecovery({ threadRef, url, code: -105, description: "down" });
    const retriedInput = io.run.mock.calls[1]?.[2] as {
      input: { commandId: string; message: { messageId: string; text: string } };
    };
    expect(retriedInput.input.commandId).toBe(failedInput.input.commandId);
    expect(retriedInput.input.message.messageId).toBe(failedInput.input.message.messageId);
    expect(retriedInput.input.message.text).toBe(failedInput.input.message.text);
    expect(state()).toEqual({ status: "sent" });
  });

  it("rejects missing threads without dispatching and permits archived threads", async () => {
    io.shell = null;
    await requestPreviewRecovery({ threadRef, url, code: -105, description: "down" });
    expect(io.run).not.toHaveBeenCalled();
    expect(state()).toEqual({
      status: "error",
      error: "This thread is no longer available to restore the preview.",
    });

    io.shell = shell({ archivedAt: "2026-10-01T00:00:00.000Z" });
    await requestPreviewRecovery({ threadRef, url, code: -105, description: "down" });
    expect(io.run).toHaveBeenCalledTimes(1);
  });

  it("clears suppression after successful navigation", async () => {
    await requestPreviewRecovery({ threadRef, url, code: -105, description: "down" });
    const previousInput = io.run.mock.calls[0]?.[2] as {
      input: { commandId: string; message: { messageId: string } };
    };
    clearPreviewRecoveryRequest(threadRef, url);
    expect(state()).toEqual({ status: "idle" });
    io.claim.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        commandId: CommandId.make("server-command-after-success"),
        messageId: MessageId.make("server-message-after-success"),
      },
    });

    await requestPreviewRecovery({ threadRef, url, code: -105, description: "down again" });
    const nextInput = io.run.mock.calls[1]?.[2] as {
      input: { commandId: string; message: { messageId: string } };
    };
    expect(io.run).toHaveBeenCalledTimes(2);
    expect(nextInput.input.commandId).not.toBe(previousInput.input.commandId);
    expect(nextInput.input.message.messageId).not.toBe(previousInput.input.message.messageId);
  });

  it("persists accepted identity and suppresses a duplicate after hydration", async () => {
    await requestPreviewRecovery({ threadRef, url, code: -105, description: "down" });
    await usePreviewRecoveryRequestStore.persist.rehydrate();

    expect(state()).toEqual({ status: "sent" });
    await requestPreviewRecovery({ threadRef, url, code: -105, description: "still down" });
    expect(io.run).toHaveBeenCalledTimes(1);
  });

  it("hydrates an interrupted send as retryable and preserves its exact dispatch identity", async () => {
    const key = JSON.stringify([scopedThreadKey(threadRef), url]);
    const snapshot = {
      text: "Restore the preview at the original URL",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required" as const,
      interactionMode: "plan" as const,
      createdAt: "2026-10-02T21:00:00.000Z",
    };
    usePreviewRecoveryRequestStore.getState().setEntry(key, {
      state: { status: "sending" },
      commandId: CommandId.make("pending-command"),
      messageId: MessageId.make("pending-message"),
      createdAt: "2026-10-02T21:00:00.000Z",
      snapshot,
    });
    await usePreviewRecoveryRequestStore.persist.rehydrate();
    expect(state()).toEqual({
      status: "error",
      error: "The app restarted before confirming this request. Retry safely.",
    });

    io.claim.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        commandId: CommandId.make("pending-command"),
        messageId: MessageId.make("pending-message"),
      },
    });

    await requestPreviewRecovery({ threadRef, url, code: -999, description: "new page error" });
    expect(io.run).toHaveBeenCalledTimes(1);
    const hydratedRetryInput = io.run.mock.calls[0]?.[2] as {
      input: {
        commandId: string;
        createdAt: string;
        message: { messageId: string; text: string };
      };
    };
    expect(hydratedRetryInput.input.commandId).toBe(CommandId.make("pending-command"));
    expect(hydratedRetryInput.input.message.messageId).toBe("pending-message");
    expect(hydratedRetryInput.input.createdAt).toBe(snapshot.createdAt);
    expect(hydratedRetryInput.input.message.text).toBe(snapshot.text);
  });

  it("prunes persisted identities after 24 hours", async () => {
    const key = JSON.stringify([scopedThreadKey(threadRef), url]);
    usePreviewRecoveryRequestStore.getState().setEntry(key, {
      state: { status: "sent" },
      commandId: CommandId.make("expired-command"),
      messageId: MessageId.make("expired-message"),
      createdAt: "2026-10-01T00:00:00.000Z",
      snapshot: null,
    });
    await usePreviewRecoveryRequestStore.persist.rehydrate();

    expect(state()).toEqual({ status: "idle" });
    await requestPreviewRecovery({ threadRef, url, code: -105, description: "still down" });
    expect(io.run).toHaveBeenCalledTimes(1);
  });
});
