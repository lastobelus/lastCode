import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  OrchestrationV2Command,
  THREAD_ANNOTATION_MAX_BODY_CHARS,
  ThreadAnnotation,
} from "./orchestrationV2.ts";

const decodeAnnotation = Schema.decodeUnknownEffect(ThreadAnnotation);
const decodeCommand = Schema.decodeUnknownEffect(OrchestrationV2Command);

it.effect("decodes Markdown annotations and rejects empty or oversized bodies", () =>
  Effect.gen(function* () {
    const annotation = yield* decodeAnnotation({
      body: "# Header\n\n- [ ] Todo\n- #tag",
      anchorMessageId: "message-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: null,
    });
    assert.match(annotation.body, /#tag/);

    assert.strictEqual(
      (yield* Effect.exit(decodeAnnotation({ ...annotation, body: "   " })))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* Effect.exit(
        decodeAnnotation({ ...annotation, body: "x".repeat(THREAD_ANNOTATION_MAX_BODY_CHARS + 1) }),
      ))._tag,
      "Failure",
    );
  }),
);

it.effect("decodes annotation client commands and domain events", () =>
  Effect.gen(function* () {
    const upsert = yield* decodeCommand({
      type: "thread.annotation.upsert",
      commandId: "command-1",
      threadId: "thread-1",
      body: "Note",
    });
    assert.strictEqual(upsert.type, "thread.annotation.upsert");

    for (const type of ["thread.annotation.resolve", "thread.annotation.reopen"]) {
      const command = yield* decodeCommand({ type, commandId: "command-2", threadId: "thread-1" });
      assert.strictEqual(command.type, type);
    }
  }),
);
