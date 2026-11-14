import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ThreadWaitHandle } from "./environmentHttp.ts";

it("decodes strict compact wait handles", () => {
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ThreadWaitHandle), {
    onExcessProperty: "error",
  });
  const value = decode(
    '{"kind":"wait-handle","environmentId":"env-1","threadId":"thread-1","messageId":"message-1"}',
  );
  expect(value.kind).toBe("wait-handle");
  expect(() =>
    decode(
      '{"kind":"accepted","environmentId":"env-1","threadId":"thread-1","messageId":"message-1"}',
    ),
  ).toThrow();
  expect(() =>
    decode(
      '{"kind":"wait-handle","environmentId":"env-1","threadId":"thread-1","messageId":"message-1","extra":true}',
    ),
  ).toThrow();
});
