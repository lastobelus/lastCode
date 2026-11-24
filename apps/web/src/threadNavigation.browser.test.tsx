import { browserThreadLinkTarget } from "@t3tools/shared/threadLinks";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { getRouter } from "./router";
import { safeThreadRouteParams } from "./threadRoutes";
import { Route as HostedThreadRoute } from "./routes/threads.$environmentId.$threadId";
import { render } from "../test/render";

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

it("shows the existing not-found fallback when a hosted redirect is rejected", async () => {
  const component = HostedThreadRoute.options.component;
  if (!component) throw new Error("The hosted thread route must provide its redirect component");
  const root = createRootRoute({
    component: Outlet,
    notFoundComponent: () => <p>Page not found</p>,
  });
  const hosted = createRoute({
    getParentRoute: () => root,
    path: "threads/$environmentId/$threadId",
    component,
  });
  const settings = createRoute({ getParentRoute: () => root, path: "settings/secrets" });
  const router = createRouter({
    routeTree: root.addChildren([hosted, settings]),
    history: createMemoryHistory({ initialEntries: ["/threads/settings/secrets"] }),
  });
  await router.load();
  await using screen = await render(<RouterProvider router={router} />, {
    // Exercise the real redirect within the router that supplies its not-found boundary.
    router: false,
  });
  await expect.element(screen.getByText("Page not found")).toBeVisible();
  expect(router.state.location.pathname).toBe("/threads/settings/secrets");
});
