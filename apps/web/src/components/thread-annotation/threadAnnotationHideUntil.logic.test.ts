import { CommandId, MessageId, ThreadId, type ThreadAnnotation } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  annotationDatePreset,
  annotationEditorEdit,
  annotationRevealReason,
  annotationTriggerInput,
  formatAnnotationDateTime,
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

  it("uses the viewer’s calendar for presets and keeps a single instant when viewed in another zone", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    try {
      const tomorrow = annotationDatePreset(now, "tomorrow");
      expect(tomorrow).toEqual({ kind: "date", date: "2026-11-23", time: "09:00" });
      const input = tomorrow && annotationTriggerInput(tomorrow, serverVersion, now);
      expect(input).toEqual({ kind: "date", at: "2026-11-23T00:00:00.000Z" });
      expect(annotationDatePreset(now, "monday")?.date).toBe("2026-11-23");
      expect(annotationDatePreset(now, "week")?.date).toBe("2026-11-29");

      vi.stubEnv("TZ", "America/New_York");
      expect(
        storedHideUntilDraft({ ...trigger, kind: "date", at: "2026-11-23T00:00:00.000Z" }),
      ).toEqual({ kind: "date", date: "2026-11-22", time: "19:00" });
      expect(formatAnnotationDateTime("2026-11-23T00:05:00.000Z", "en-US")).toMatch(
        /Nov 22, 2026.*19:05/u,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("offers today’s afternoon and evening times only before they arrive", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    try {
      const afternoon = { kind: "date", date: "2026-11-22", time: "13:00" };
      const tonight = { kind: "date", date: "2026-11-22", time: "19:00" };
      expect(annotationDatePreset(now, "afternoon")).toEqual(afternoon);
      expect(annotationDatePreset(now, "tonight")).toEqual(tonight);
      const atAfternoon = Date.parse("2026-11-22T04:00:00.000Z");
      expect(annotationDatePreset(atAfternoon, "afternoon")).toBeNull();
      expect(annotationDatePreset(atAfternoon, "tonight")).toEqual(tonight);
      expect(annotationDatePreset(Date.parse("2026-11-22T10:01:00.000Z"), "tonight")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("schedules an elapsed hour even through a repeated local hour", () => {
    vi.stubEnv("TZ", "America/New_York");
    try {
      const beforeFallback = Date.parse("2026-11-01T05:30:37.000Z");
      const draft = annotationDatePreset(beforeFallback, "hour");
      expect(draft).toMatchObject({ kind: "date", date: "2026-11-01", time: "01:30" });
      expect(draft && annotationTriggerInput(draft, serverVersion, beforeFallback)).toEqual({
        kind: "date",
        at: "2026-11-01T06:30:37.000Z",
      });
      const beforeMidnight = Date.parse("2026-11-22T04:40:00.000Z");
      expect(annotationDatePreset(beforeMidnight, "hour")).toMatchObject({
        kind: "date",
        date: "2026-11-22",
        time: "00:40",
      });
      expect(formatAnnotationDateTime("2026-11-22T05:05:00.000Z", "en-US")).toMatch(/00:05/u);
    } finally {
      vi.unstubAllEnvs();
    }
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
