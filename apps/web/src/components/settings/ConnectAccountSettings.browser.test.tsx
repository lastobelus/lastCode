import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ConnectAccountSettings } from "./ConnectAccountSettings";

const state = vi.hoisted(() => ({
  configured: true,
  status: "ready",
  signedIn: false,
  signIn: vi.fn(),
  signOut: vi.fn(),
  manage: vi.fn(),
  useUser: vi.fn(),
}));

vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => state.configured }));
vi.mock("../clerk/useT3ConnectAuthPrompt", () => ({
  useT3ConnectAuthPrompt: () => ({ openAuthPrompt: state.signIn }),
}));
vi.mock("../clerk/T3ConnectAccountPages", () => ({
  useT3ConnectAccountPage: () => ({ open: state.signedIn ? state.manage : null, portals: null }),
}));
vi.mock("@clerk/react", () => ({
  ClerkLoading: ({ children }: { children: ReactNode }) =>
    state.status === "loading" ? children : null,
  ClerkFailed: ({ children }: { children: ReactNode }) =>
    state.status === "error" ? children : null,
  ClerkDegraded: ({ children }: { children: ReactNode }) =>
    state.status === "degraded" ? children : null,
  ClerkLoaded: ({ children }: { children: ReactNode }) =>
    ["ready", "degraded"].includes(state.status) ? children : null,
  useClerk: () => ({ signOut: state.signOut }),
  useUser: () => {
    state.useUser();
    return {
      isLoaded: true,
      isSignedIn: state.signedIn,
      user: state.signedIn ? { primaryEmailAddress: { emailAddress: "person@example.com" } } : null,
    };
  },
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({
    children,
    title,
    id,
  }: {
    children: ReactNode;
    title: string;
    id: string;
  }) => (
    <section id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

function setup() {
  state.configured = true;
  state.status = "ready";
  state.signedIn = false;
  state.signIn.mockReset();
  state.signOut.mockReset().mockResolvedValue(undefined);
  state.manage.mockReset();
  state.useUser.mockClear();
}

it("keeps unavailable accounts visible without mounting Clerk hooks", async () => {
  setup();
  state.configured = false;
  await using screen = await render(<ConnectAccountSettings />);
  await expect.element(screen.getByRole("heading", { name: "T3 Connect" })).toBeVisible();
  await expect.element(screen.getByText(/T3 Connect sign-in is unavailable/)).toBeVisible();
  expect(state.useUser).not.toHaveBeenCalled();
});

it.each(["loading", "error", "degraded"])(
  "offers recovery when authentication is %s",
  async (status) => {
    setup();
    state.status = status;
    await using screen = await render(<ConnectAccountSettings />);
    await expect.element(screen.getByRole("button", { name: "Reload page" })).toBeVisible();
    if (status === "loading") {
      await expect.element(screen.getByText("Loading account…")).toBeVisible();
    } else {
      await expect.element(screen.getByRole("alert")).toBeVisible();
    }
    if (status !== "degraded") expect(state.useUser).not.toHaveBeenCalled();
  },
);

it("signs in without enabling a host tunnel and offers account management and sign-out", async () => {
  setup();
  await using screen = await render(<ConnectAccountSettings />);
  await screen.getByRole("button", { name: "Sign in to T3 Connect" }).click();
  expect(state.signIn).toHaveBeenCalledOnce();

  state.signedIn = true;
  await screen.rerender(<ConnectAccountSettings key={String(state.signedIn)} />);
  await expect.element(screen.getByText("Signed in as person@example.com.")).toBeVisible();
  await screen.getByRole("button", { name: "Manage account" }).click();
  expect(state.manage).toHaveBeenCalledOnce();
  await screen.getByRole("button", { name: "Sign out", exact: true }).click();
  expect(state.signOut).toHaveBeenCalledOnce();

  state.signedIn = false;
  await screen.rerender(<ConnectAccountSettings key={String(state.signedIn)} />);
  await expect.element(screen.getByRole("button", { name: "Sign in to T3 Connect" })).toBeVisible();
});

it("keeps failed account actions retryable", async () => {
  setup();
  state.signedIn = true;
  state.signOut.mockRejectedValueOnce(new Error("offline"));
  await using screen = await render(<ConnectAccountSettings />);
  await screen.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect.element(screen.getByText(/Could not complete the account action/)).toBeVisible();
  await screen.getByRole("button", { name: "Sign out", exact: true }).click();
  expect(state.signOut).toHaveBeenCalledTimes(2);
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});
