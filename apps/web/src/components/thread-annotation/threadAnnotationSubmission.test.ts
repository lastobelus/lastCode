import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { useComposerDraftStore } from "../../composerDraftStore";
import { threadContextRecord } from "../../lib/composerContextRecords";
import {
  parseThreadAnnotationSubmission,
  saveThreadAnnotationSubmission,
} from "./threadAnnotationSubmission";

const target = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
const otherTarget = scopeThreadRef(target.environmentId, ThreadId.make("other-thread"));
const file = {
  type: "file" as const,
  id: "file",
  name: "notes.pdf",
  mimeType: "application/pdf",
  sizeBytes: 12,
  file: null,
};

beforeEach(() => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  useComposerDraftStore.getState().setPrompt(target, "/annotate note");
});

describe("annotation submission", () => {
  it("intercepts a text-only annotation command", () => {
    expect(
      parseThreadAnnotationSubmission(
        "/annotate note",
        useComposerDraftStore.getState().getComposerDraft(target),
      ),
    ).toEqual({ kind: "save", body: "note" });
  });

  it.each(["file", "thread"] as const)(
    "keeps a command with %s content as a provider prompt",
    (kind) => {
      const store = useComposerDraftStore.getState();
      if (kind === "file") store.addFiles(target, [file]);
      else store.setThreadContexts(target, [threadContextRecord(otherTarget, "Related work")]);
      expect(
        parseThreadAnnotationSubmission("/annotate note", store.getComposerDraft(target)),
      ).toBeNull();
      expect(store.getComposerDraft(target)?.prompt).toContain("/annotate note");
    },
  );

  it.each(["prompt", "file", "thread"] as const)(
    "keeps newer %s content when an earlier save completes",
    async (kind) => {
      const store = useComposerDraftStore.getState();
      const submittedDraft = store.getComposerDraft(target);
      let finish!: (saved: boolean) => void;
      let editorText = "/annotate note";
      const pending = saveThreadAnnotationSubmission({
        target,
        draft: submittedDraft,
        save: () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
        onDraftConsumed: () => {
          editorText = "";
        },
      });
      if (kind === "prompt") store.setPrompt(target, "New task");
      else if (kind === "file") store.addFiles(target, [file]);
      else store.setThreadContexts(target, [threadContextRecord(otherTarget, "Related work")]);
      const newDraft = store.getComposerDraft(target);
      finish(true);
      await pending;
      expect(store.getComposerDraft(target)).toBe(newDraft);
      expect(editorText).toBe("/annotate note");
    },
  );

  it("consumes only the originating draft after navigation", async () => {
    const store = useComposerDraftStore.getState();
    let finish!: (saved: boolean) => void;
    let currentTarget = target;
    let editorText = "/annotate note";
    const pending = saveThreadAnnotationSubmission({
      target,
      draft: store.getComposerDraft(target),
      save: () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      onDraftConsumed: () => {
        if (currentTarget === target) editorText = "";
      },
    });
    store.setPrompt(otherTarget, "Other task");
    currentTarget = otherTarget;
    editorText = "Other task";
    finish(true);
    await pending;
    expect(store.getComposerDraft(target)?.prompt ?? "").toBe("");
    expect(store.getComposerDraft(otherTarget)?.prompt).toBe("Other task");
    expect(editorText).toBe("Other task");
  });

  it("keeps the submitted command when saving fails", async () => {
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(target);
    await expect(
      saveThreadAnnotationSubmission({
        target,
        draft,
        save: async () => false,
        onDraftConsumed: () => {
          throw new Error("Must preserve editor");
        },
      }),
    ).resolves.toBe(false);
    expect(store.getComposerDraft(target)).toBe(draft);
  });
});
