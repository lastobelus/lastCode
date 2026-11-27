import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SidebarBrandCheckpoint } from "./SidebarBrandCheckpoint";

vi.mock(import("../../branding"), async (importOriginal) => ({
  ...(await importOriginal()),
  APP_VERSION: "0.1.14-nightly.20261127.5332.1",
}));

it("shows and copies the checkpoint number from the running build", async () => {
  await using screen = await render(<SidebarBrandCheckpoint onBackdrop={false} />);
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

  const button = screen.getByRole("button", { name: "Copy checkpoint 5332" });
  expect(button.element().textContent).toBe("5332");
  await button.click();

  expect(write).toHaveBeenCalledExactlyOnceWith("checkpoint 5332");
});
