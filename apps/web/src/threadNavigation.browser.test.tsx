import { browserThreadLinkTarget } from "@t3tools/shared/threadLinks";
import { createMemoryHistory } from "@tanstack/react-router";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { getRouter } from "./router";
import { safeThreadRouteParams } from "./threadRoutes";

it("never resolves an untrusted thread reference to a static app route", () => {
  const router = getRouter(createMemoryHistory());
  for (const environmentId of [
    "settings",
    "draft",
    "projects",
    "threads",
    ".",
    "..",
    "settings/../settings",
  ]) {
    expect(
      safeThreadRouteParams(router, {
        environmentId: EnvironmentId.make(environmentId),
        threadId: ThreadId.make("secrets"),
      }),
    ).toBeNull();
  }
  for (const href of [
    "t3-thread://v2/settings/secrets",
    "t3-thread://v2/%73ettings/secrets",
    "t3-thread://v2/%2573ettings/secrets",
    "https://app.t3.codes/threads/settings/secrets",
    "t3-thread://v2/%2e%2e/settings",
  ]) {
    const target = browserThreadLinkTarget(href, EnvironmentId.make("source"), []);
    expect(target && safeThreadRouteParams(router, target)).toBeNull();
  }
  expect(
    safeThreadRouteParams(router, {
      environmentId: EnvironmentId.make("unknown-environment"),
      threadId: ThreadId.make("unknown-thread"),
    }),
  ).toEqual({ environmentId: "unknown-environment", threadId: "unknown-thread" });
});
