import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  MessageId,
  type ScopedThreadRef,
  type ThreadAnnotation,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: new Map<string, boolean>(),
  save: vi.fn<(value: unknown) => Promise<AtomCommandResult<void, Error>>>(),
  resolve: vi.fn<(value: unknown) => Promise<AtomCommandResult<void, Error>>>(),
  reopen: vi.fn<(value: unknown) => Promise<AtomCommandResult<void, Error>>>(),
  toast: vi.fn(),
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (id, scope) =>
    scope === AuthOrchestrationOperateScope && state.scopes.get(id) === true,
  useEnvironmentScope: (id, scope) =>
    id !== null && scope === AuthOrchestrationOperateScope && state.scopes.get(id) === true,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("../../state/threads"), async (original) => ({
  ...(await original()),
  threadEnvironment: {
    ...(await original()).threadEnvironment,
    upsertAnnotation: state.save,
    resolveAnnotation: state.resolve,
    reopenAnnotation: state.reopen,
  } as never,
}));
vi.mock(import("../ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: { add: state.toast } as never,
}));

import { useChatThreadAnnotation } from "./useChatThreadAnnotation";
import { runThreadAnnotationBodySave } from "./ThreadAnnotation";
import { ComposerBannerStack } from "../chat/ComposerBannerStack";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useUiStateStore } from "../../uiStateStore";
import { threadContextRecord } from "../../lib/composerContextRecords";

const a: ScopedThreadRef = {
  environmentId: EnvironmentId.make("annotation-environment-a"),
  threadId: ThreadId.make("annotation-thread-a"),
};
const b: ScopedThreadRef = {
  environmentId: EnvironmentId.make("annotation-environment-b"),
  threadId: ThreadId.make("annotation-thread-b"),
};
const note: ThreadAnnotation = {
  anchorMessageId: MessageId.make("anchor"),
  body: "# Follow up\n\n- [ ] Confirm the fix",
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
  resolvedAt: null,
};
const success = () => AsyncResult.success(undefined);
function deferred() {
  let resolve!: (value: AtomCommandResult<void, Error>) => void;
  const promise = new Promise<AtomCommandResult<void, Error>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let root: Root;
let container: HTMLDivElement;
let controls: ReturnType<typeof useChatThreadAnnotation>;
type Input = Parameters<typeof useChatThreadAnnotation>[0];
const defaults: Input = {
  routeThreadRef: a,
  threadRef: a,
  annotation: note,
  supported: true,
  hasUserMessage: () => true,
  cwd: null,
};
function Probe({ input }: { input: Input }) {
  const value = useChatThreadAnnotation(input);
  useLayoutEffect(() => {
    controls = value;
  });
  return (
    <>
      <button onClick={value.openEditor}>Open annotation</button>
      <ComposerBannerStack items={value.banner ? [value.banner] : []} />
      {value.editor}
    </>
  );
}
async function render(overrides: Partial<Input> = {}) {
  await act(async () => root.render(<Probe input={{ ...defaults, ...overrides }} />));
}
function button(label: string) {
  const result = [...document.querySelectorAll("button")].find(
    (node) => node.textContent === label || node.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function editor() {
  return document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Thread annotation"]');
}
async function enter(value: string) {
  await act(async () => {
    const textarea = editor();
    if (!textarea) throw new Error("Missing editor");
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit(
  prompt: string,
  overrides: Partial<Parameters<typeof controls.interceptSubmission>[0]> = {},
) {
  let handled = false;
  await act(async () => {
    handled = await controls.interceptSubmission({
      target: a,
      prompt,
      directAnnotation: false,
      onDraftConsumed: vi.fn(),
      ...overrides,
    });
  });
  return handled;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.scopes.set(a.environmentId, true);
  state.scopes.set(b.environmentId, true);
  for (const command of [state.save, state.resolve, state.reopen])
    command.mockReset().mockResolvedValue(success());
  state.toast.mockReset();
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  useUiStateStore.setState({ threadAnnotationExpandedById: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat annotation ownership", () => {
  it("edits and saves Markdown through the destination command", async () => {
    await render();
    await click("Edit");
    expect(editor()?.value).toBe(note.body);
    await enter("  New note  ");
    await click("Save");
    expect(state.save).toHaveBeenCalledExactlyOnceWith({
      environmentId: a.environmentId,
      input: { threadId: a.threadId, body: "New note" },
    });
    await expect.poll(editor).toBeNull();
  });
  it("resolves from the banner and reopens from the timeline", async () => {
    await render();
    await click("Resolve");
    expect(state.resolve).toHaveBeenCalledOnce();
    await render({ annotation: { ...note, resolvedAt: note.updatedAt } });
    expect(controls.banner).toBeNull();
    await act(async () => controls.timeline.onAnnotationReopen?.());
    expect(state.reopen).toHaveBeenCalledExactlyOnceWith({
      environmentId: a.environmentId,
      input: { threadId: a.threadId },
    });
  });
  it("dismisses only the current version and resets on navigation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render();
    await click("Dismiss thread annotation");
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(controls.banner).toBeNull();
    await render({ annotation: { ...note, updatedAt: "2026-09-04T00:00:00.000Z" } });
    expect(controls.banner).not.toBeNull();
    await click("Dismiss thread annotation");
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await render({ routeThreadRef: b, threadRef: b });
    await render();
    expect(controls.banner).not.toBeNull();
  });
  it("retains expansion in read-only mode without edit or body commands", async () => {
    state.scopes.set(a.environmentId, false);
    await render();
    expect(controls.canAnnotate).toBe(false);
    expect(controls.timeline.onAnnotationBodyChange).toBeUndefined();
    expect(container.textContent).not.toContain("Resolve");
    await click("Expand annotation");
    expect(button("Collapse annotation")).toBeDefined();
  });
  it("preserves banner actions on an older server while blocking editing", async () => {
    await render({ supported: false });
    expect(button("Edit")).toBeDefined();
    await click("Edit");
    expect(editor()).toBeNull();
    await click("Resolve");
    expect(state.resolve).not.toHaveBeenCalled();
    await submit("/annotate note");
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Annotations unavailable" }),
    );
  });
  it.each([
    { threadRef: null, annotation: null, hasUserMessage: () => false, expected: false },
    { annotation: null, hasUserMessage: () => false, expected: false },
    { annotation: null, hasUserMessage: () => true, expected: true },
    { annotation: note, hasUserMessage: () => false, expected: true },
    { supported: false, expected: false },
  ])(
    "applies persisted-thread, first-message and capability eligibility %j",
    async ({ expected, ...input }) => {
      await render(input);
      expect(controls.canAnnotate).toBe(expected);
    },
  );
  it("rechecks the destination grant for retained save/resolve/reopen callbacks", async () => {
    await render();
    const retained = controls.timeline;
    state.scopes.set(a.environmentId, false);
    await act(async () => {
      expect(await retained.onAnnotationBodyChange?.("Denied")).toBe(false);
      retained.onAnnotationResolve?.();
      retained.onAnnotationReopen?.();
    });
    expect(state.save).not.toHaveBeenCalled();
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.reopen).not.toHaveBeenCalled();
    state.scopes.set(a.environmentId, true);
    await act(async () => {
      await retained.onAnnotationBodyChange?.("Allowed");
    });
    expect(state.save).toHaveBeenCalledOnce();
  });
  it("evaluates the first-message fact only when annotation creation is eligible", async () => {
    const hasUserMessage = vi.fn(() => true);
    await render({ hasUserMessage });
    await render({ hasUserMessage, supported: false, annotation: null });
    await render({ hasUserMessage, threadRef: null, annotation: null });
    state.scopes.set(a.environmentId, false);
    await render({ hasUserMessage, annotation: null });
    expect(hasUserMessage).not.toHaveBeenCalled();
    state.scopes.set(a.environmentId, true);
    await render({ hasUserMessage, annotation: null });
    expect(hasUserMessage).toHaveBeenCalledOnce();
  });
  it("keeps resolution pending until its receipt and reports only real failures", async () => {
    const pending = deferred();
    state.resolve.mockReturnValueOnce(pending.promise);
    await render();
    await click("Resolve");
    expect(button("Resolve").disabled).toBe(true);
    await act(async () => {
      pending.resolve(AsyncResult.failure(Cause.fail(new Error("Resolve failed"))));
      await pending.promise;
    });
    expect(button("Resolve").disabled).toBe(false);
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Failed to resolve annotation" }),
    );
    state.toast.mockClear();
    state.reopen.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt(1)));
    await act(async () => controls.timeline.onAnnotationReopen?.());
    expect(state.toast).not.toHaveBeenCalled();
  });
  it("shares chat's pending body save with a later sidebar save", async () => {
    const pending = deferred();
    state.save.mockReturnValueOnce(pending.promise);
    await render();
    let chat!: Promise<boolean>;
    await act(async () => {
      chat = controls.timeline.onAnnotationBodyChange!("Chat update");
    });
    const sidebar = vi.fn(async () => true);
    expect(await runThreadAnnotationBodySave(a, sidebar)).toBe(false);
    expect(sidebar).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve(success());
      await chat;
    });
    expect(await runThreadAnnotationBodySave(a, sidebar)).toBe(true);
  });
  it("shows pending controls, preserves failed editor drafts and silences interruption", async () => {
    const pending = deferred();
    state.save.mockReturnValueOnce(pending.promise);
    await render();
    await click("Edit");
    await enter("Keep this draft");
    await click("Save");
    expect(button("Saving…").disabled).toBe(true);
    await act(async () => {
      pending.resolve(AsyncResult.failure(Cause.fail(new Error("Offline"))));
      await pending.promise;
    });
    expect(editor()?.value).toBe("Keep this draft");
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Failed to save annotation", description: "Offline" }),
    );
    state.toast.mockClear();
    state.save.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt(1)));
    await click("Save");
    expect(editor()?.value).toBe("Keep this draft");
    expect(state.toast).not.toHaveBeenCalled();
  });
  it("keeps B's editor open when A's deferred save completes", async () => {
    const pending = deferred();
    state.save.mockReturnValueOnce(pending.promise);
    await render();
    await click("Edit");
    await click("Save");
    await render({ routeThreadRef: b, threadRef: b, annotation: { ...note, body: "B note" } });
    await click("Edit");
    await enter("B unsaved");
    await act(async () => {
      pending.resolve(success());
      await pending.promise;
    });
    expect(editor()?.value).toBe("B unsaved");
    expect(state.save.mock.calls[0]?.[0]).toEqual({
      environmentId: a.environmentId,
      input: { threadId: a.threadId, body: note.body },
    });
  });
  it("keeps a newer editor session on A after cancel/reopen during a save", async () => {
    const pending = deferred();
    state.save.mockReturnValueOnce(pending.promise);
    await render();
    await click("Edit");
    await click("Save");
    await click("Cancel");
    await click("Open annotation");
    await enter("New A draft");
    await act(async () => {
      pending.resolve(success());
      await pending.promise;
    });
    expect(editor()?.value).toBe("New A draft");
  });
  it("shares body-save exclusion with sidebar saves and banner checkboxes", async () => {
    await render();
    await click("Expand annotation");
    let release!: (value: boolean) => void;
    const sidebar = runThreadAnnotationBodySave(
      a,
      () =>
        new Promise<boolean>((done) => {
          release = done;
        }),
    );
    await act(async () => {
      expect(await controls.timeline.onAnnotationBodyChange?.("Overlapping")).toBe(false);
    });
    expect(state.save).not.toHaveBeenCalled();
    await act(async () => {
      release(true);
      await sidebar;
    });
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    await act(async () => checkbox?.click());
    expect(state.save).toHaveBeenCalledExactlyOnceWith({
      environmentId: a.environmentId,
      input: { threadId: a.threadId, body: "# Follow up\n\n- [x] Confirm the fix" },
    });
  });
});

describe("annotation slash interception", () => {
  it("opens the editor and consumes the text-only draft", async () => {
    useComposerDraftStore.getState().setPrompt(a, "/annotate");
    await render();
    const consumed = vi.fn();
    expect(await submit("/annotate", { onDraftConsumed: consumed })).toBe(true);
    expect(consumed).toHaveBeenCalledOnce();
    expect(editor()).not.toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(a)?.prompt ?? "").toBe("");
  });
  it("declines ordinary prompts synchronously without changing their draft", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(a, "Ordinary prompt");
    await render();
    const draft = store.getComposerDraft(a);
    expect(
      controls.interceptSubmission({
        target: a,
        prompt: "Ordinary prompt",
        directAnnotation: false,
        onDraftConsumed: vi.fn(),
      }),
    ).toBe(false);
    expect(store.getComposerDraft(a)).toBe(draft);
  });
  it("keeps a slash draft and explains the first-message requirement", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(a, "/annotate Details");
    await render({ annotation: null, hasUserMessage: () => false });
    expect(await submit("/annotate Details")).toBe(true);
    expect(state.save).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Send a message first" }),
    );
    expect(store.getComposerDraft(a)?.prompt).toBe("/annotate Details");
  });
  it("saves metadata independently of provider availability", async () => {
    useComposerDraftStore.getState().setPrompt(a, "/annotate Details");
    await render();
    expect(await submit("/annotate Details")).toBe(true);
    expect(state.save).toHaveBeenCalledOnce();
  });
  it.each(["file", "context", "direct"] as const)(
    "leaves %s-bearing commands on the ordinary-send path",
    async (kind) => {
      const store = useComposerDraftStore.getState();
      store.setPrompt(a, "/annotate Details");
      if (kind === "file")
        store.addFiles(a, [
          {
            type: "file",
            id: "file",
            name: "notes.pdf",
            mimeType: "application/pdf",
            sizeBytes: 12,
            file: null,
          },
        ]);
      if (kind === "context") store.setThreadContexts(a, [threadContextRecord(b, "Related")]);
      await render();
      expect(await submit("/annotate Details", { directAnnotation: kind === "direct" })).toBe(
        false,
      );
      expect(state.save).not.toHaveBeenCalled();
      expect(store.getComposerDraft(a)?.prompt).toContain("/annotate Details");
    },
  );
  it.each(["prompt", "file", "context"] as const)(
    "keeps newer A %s and B's draft during a deferred slash save",
    async (kind) => {
      const store = useComposerDraftStore.getState();
      store.setPrompt(a, "/annotate Details");
      const pending = deferred();
      state.save.mockReturnValueOnce(pending.promise);
      await render();
      const consumed = vi.fn();
      let save!: boolean | Promise<boolean>;
      await act(async () => {
        save = controls.interceptSubmission({
          target: a,
          prompt: "/annotate Details",
          directAnnotation: false,
          onDraftConsumed: consumed,
        });
      });
      if (kind === "prompt") store.setPrompt(a, "New A prompt");
      if (kind === "file")
        store.addFiles(a, [
          {
            type: "file",
            id: "file",
            name: "notes.pdf",
            mimeType: "application/pdf",
            sizeBytes: 12,
            file: null,
          },
        ]);
      if (kind === "context") store.setThreadContexts(a, [threadContextRecord(b, "Related")]);
      const newer = store.getComposerDraft(a);
      store.setPrompt(b, "B prompt");
      await render({ routeThreadRef: b, threadRef: b });
      await act(async () => {
        pending.resolve(success());
        await save;
      });
      expect(store.getComposerDraft(a)).toBe(newer);
      expect(store.getComposerDraft(b)?.prompt).toBe("B prompt");
      expect(consumed).not.toHaveBeenCalled();
    },
  );
});
