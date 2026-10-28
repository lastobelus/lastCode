import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  hasOpenActionableDashboardItems,
  OrchestrationV2Command,
  ThreadDashboardItemInput,
  ThreadDashboardItems,
} from "./orchestrationV2.ts";

const input = {
  id: "qa:editor",
  title: "Check the editor",
  body: "Verify the preview and exported file.",
  kind: "qa",
  status: "open",
  priority: "high",
  effort: "focused",
  requiresComputer: true,
} as const;

const decode = Schema.decodeUnknownEffect(ThreadDashboardItemInput);
const decodeItems = Schema.decodeUnknownEffect(ThreadDashboardItems);
const decodeCommand = Schema.decodeUnknownEffect(OrchestrationV2Command);

it.effect("bounds dashboard items and validates explicit request state", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* decode(input), input);
    for (const invalid of [
      { id: " " },
      { id: "x".repeat(81) },
      { title: " " },
      { title: "x".repeat(161) },
      { body: "x".repeat(4_001) },
      { status: "done" },
      { kind: "alert" },
      { requiresComputer: "true" },
    ]) {
      assert.equal((yield* Effect.exit(decode({ ...input, ...invalid })))._tag, "Failure");
    }
    const item = {
      ...input,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    assert.equal((yield* Effect.exit(decodeItems([item, item])))._tag, "Failure");
    assert.equal(
      (yield* Effect.exit(
        decodeItems(Array.from({ length: 33 }, (_, i) => ({ ...item, id: `item-${i}` }))),
      ))._tag,
      "Failure",
    );
    assert.isTrue(hasOpenActionableDashboardItems([item]));
    assert.isFalse(hasOpenActionableDashboardItems([{ ...item, status: "resolved" }]));
    assert.isFalse(hasOpenActionableDashboardItems([{ ...item, kind: "metric" }]));
    for (const command of [
      { type: "thread.dashboard-item.upsert", item: input },
      { type: "thread.dashboard-item.remove", itemId: input.id },
    ]) {
      assert.equal(
        (yield* decodeCommand({
          ...command,
          commandId: "command-1",
          threadId: "thread-1",
        })).type,
        command.type,
      );
    }
  }),
);
