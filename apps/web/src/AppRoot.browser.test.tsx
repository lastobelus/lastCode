import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { AppRoot } from "./AppRoot";
import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import type { AppRouter } from "./router";
import { render } from "../test/render";

vi.mock(import("./browser/ElectronBrowserHost"), { spy: true });

it("navigates through the persistent Browser host beside the router", async () => {
  const root = createRootRoute({ component: Outlet });
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <p>App ready</p>,
  });
  const chat = createRoute({ getParentRoute: () => root, id: "_chat", component: Outlet });
  const thread = createRoute({
    getParentRoute: () => chat,
    path: "$environmentId/$threadId",
    component: () => <p>Thread opened</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([index, chat.addChildren([thread])]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await using screen = await render(<AppRoot router={router as unknown as AppRouter} />, {
    // AppRoot supplies its own router and keeps the real Browser host outside it.
    router: false,
  });
  await expect.element(screen.getByText("App ready")).toBeVisible();
  const navigate = vi.spyOn(router, "navigate");
  vi.mocked(ElectronBrowserHost)
    .mock.calls.at(-1)![0]
    .onThreadLink("t3-thread://v2/source/thread", EnvironmentId.make("source"));
  await navigate.mock.results.at(-1)!.value;
  await expect.element(screen.getByText("Thread opened")).toBeVisible();
  expect(router.state.location.pathname).toBe("/source/thread");
});
