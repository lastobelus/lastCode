import { CommandId, MessageId, ThreadId, type ThreadAnnotation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  annotationDatePreset,
  annotationEditorEdit,
  annotationRevealReason,
  annotationTriggerInput,
  storedHideUntilDraft,
} from "./threadAnnotationHideUntil.logic";

const now = Date.parse("2026-11-22T03:00:00.000Z");
const serverVersion = "0.1.11-nightly.20261120.4979.1";
const trigger = {
  id: CommandId.make("original-trigger"),
  hiddenAt: "2026-11-21T20:00:00.000Z",
  kind: "checkpoints",
  count: 2,
  baselineVersion: serverVersion,
  seenBuilds: [],
} as const;
const note: ThreadAnnotation = {
  anchorMessageId: MessageId.make("anchor"),
  body: "Finish the review",
  createdAt: trigger.hiddenAt,
  updatedAt: trigger.hiddenAt,
  resolvedAt: null,
  hideUntil: trigger,
};

function edit(overrides: Partial<Parameters<typeof annotationEditorEdit>[0]>) {
  return annotationEditorEdit({
    body: note.body,
    originalBody: note.body,
    annotation: note,
    draft: storedHideUntilDraft(trigger),
    now,
    serverVersion,
    supportsHideUntil: true,
    ...overrides,
  });
}

describe("annotation trigger input", () => {
  it.each(["0", "-1", "1.5", "1e2", "", "9007199254740992"])(
    "rejects an invalid checkpoint count %j",
    (count) => {
      expect(annotationTriggerInput({ kind: "checkpoints", count }, serverVersion, now)).toBeNull();
    },
  );

  it("requires a checkpoint baseline for a new hide and keeps an existing trigger during a dev run", () => {
    expect(
      annotationTriggerInput({ kind: "checkpoints", count: "1" }, "0.1.11-dev", now),
    ).toBeNull();
    expect(edit({ body: "Updated", serverVersion: "0.1.11-dev" })).toEqual({
      body: "Updated",
      bodyEdited: true,
    });
  });

  it("uses the Pacific calendar day and offset for presets and keeps a single absolute instant", () => {
    const tomorrow = annotationDatePreset(now, "tomorrow");
    expect(tomorrow).toEqual({ kind: "date", date: "2026-11-22", time: "09:00" });
    expect(annotationTriggerInput(tomorrow, serverVersion, now)).toEqual({
      kind: "date",
      at: "2026-11-22T16:00:00.000Z",
    });
    expect(annotationDatePreset(now, "monday").date).toBe("2026-11-23");
    expect(annotationDatePreset(now, "week").date).toBe("2026-11-28");
  });

  it.each(["2026-11-20", "2026-11-31", ""])("rejects past and invalid dates (%j)", (date) => {
    expect(
      annotationTriggerInput({ kind: "date", date, time: "09:00" }, serverVersion, now),
    ).toBeNull();
  });
});

describe("annotation editor edits", () => {
  it("only sends the requested fields for body edit, trigger replacement and Show now", () => {
    expect(edit({ body: "  Changed  " })).toEqual({ body: "Changed", bodyEdited: true });
    const replacement = { kind: "thread-archived", threadId: ThreadId.make("target") } as const;
    expect(edit({ draft: replacement })).toEqual({ hideUntil: replacement });
    expect(edit({ body: "  ", draft: { kind: "none" } })).toEqual({
      body: "",
      bodyEdited: true,
      hideUntil: null,
      expectedHideTriggerId: trigger.id,
    });
    expect(edit({ draft: { kind: "none" } })).toEqual({
      hideUntil: null,
      expectedHideTriggerId: trigger.id,
    });
  });

  it("allows a hide without authored text and keeps legacy writes body-only", () => {
    expect(
      edit({
        annotation: null,
        originalBody: "",
        body: "",
        draft: { kind: "checkpoints", count: "1" },
      }),
    ).toEqual({
      hideUntil: { kind: "checkpoints", count: 1 },
    });
    expect(
      edit({ annotation: null, originalBody: "", body: "", draft: { kind: "none" } }),
    ).toBeUndefined();
    expect(edit({ body: "Changed", supportsHideUntil: false })).toEqual({ body: "Changed" });
  });

  it("shows the approved checkpoint version in the automatic reveal", () => {
    expect(
      annotationRevealReason(
        {
          at: "2026-11-22T04:00:00.000Z",
          by: "trigger",
          trigger,
          outcome: "installed",
          installedVersion: serverVersion,
        },
        undefined,
        "en",
      ),
    ).toBe("2 checkpoints installed, now 2026-11-20 • 4979.1");
  });
});
