import { render, type Screen } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { LastCodeStatusIcon } from "@t3tools/contracts/settings";
import "../index.css";
import { ThreadStatusGlyph } from "./ThreadStatusGlyph";
import { configurableThreadStatuses } from "./Sidebar.logic";

const workingStatus = configurableThreadStatuses.find((status) => status.label === "Working")!;
import { ThreadStatusLabel } from "./ThreadStatusIndicators";
import { TooltipProvider } from "./ui/tooltip";

async function raster(screen: Screen, icon: LastCodeStatusIcon) {
  await screen.rerender(<ThreadStatusGlyph icon={icon} dotClass={workingStatus.dotClass} />);
  const marker = screen.container.querySelector<HTMLElement>("[data-status-shape] > span")!;
  const image = new Image();
  image.src = getComputedStyle(marker).maskImage.slice(5, -2);
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 180;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0, 180, 180);
  return context.getImageData(0, 0, 180, 180);
}

it.each([
  ["triangle", 8.196, 7.5],
  ["triangle-right", 7.5, 8.196],
  ["diamond", 8.485, 8.485],
  ["square", 6, 6],
  ["circle", 6, 6],
] as const)(
  "keeps %s's approved outer geometry and interior opacity",
  async (shape, width, height) => {
    await using screen = await render(null);
    for (const style of shape === "circle"
      ? (["open", "outline-fill"] as const)
      : (["open", "solid", "outline-fill"] as const)) {
      const { data } = await raster(screen, { shape, style });
      const xs: number[] = [];
      const ys: number[] = [];
      for (let y = 0; y < 180; y++) {
        for (let x = 0; x < 180; x++) {
          if (data[(y * 180 + x) * 4 + 3]! > 32) {
            xs.push(x);
            ys.push(y);
          }
        }
      }
      await vi.waitFor(() => {
        expect(Math.max(...xs) - Math.min(...xs) + 1).toBeCloseTo(width * 20, -1);
        expect(Math.max(...ys) - Math.min(...ys) + 1).toBeCloseTo(height * 20, -1);
        const centerAlpha = data[(90 * 180 + 90) * 4 + 3];
        expect(centerAlpha).toBe(style === "open" ? 0 : style === "solid" ? 255 : 128);
        expect(Math.max(...data.filter((_, index) => index % 4 === 3))).toBe(255);
      });
    }
  },
);

it("preserves the dot color and compact 14px slot for every shape", async () => {
  await using screen = await render(null);
  const host = screen.container;
  const status = {
    ...workingStatus,
    pulse: false,
  };
  for (const shape of ["triangle", "triangle-right", "square", "diamond", "circle"] as const) {
    await screen.rerender(
      <TooltipProvider>
        <ThreadStatusLabel status={status} compact icon={{ shape, style: "solid" }} />
      </TooltipProvider>,
    );
    await vi.waitFor(() => {
      const slot = host.querySelector<HTMLElement>('[role="img"]')!;
      const reference = host.querySelector<HTMLElement>("[data-status-shape]")!;
      const marker = reference.firstElementChild!;
      expect(slot.getBoundingClientRect().width).toBe(14);
      expect(slot.getBoundingClientRect().height).toBe(14);
      expect(reference.getBoundingClientRect().width).toBe(6);
      expect(getComputedStyle(reference).overflow).toBe("visible");
      expect(getComputedStyle(marker).backgroundColor).not.toBe(getComputedStyle(slot).color);
      expect(slot.getAttribute("aria-label")).toBe("Working");
    });
  }
});

it("truncates only the noncompact label while its marker can paint outside the reference box", async () => {
  await page.viewport(1280, 900);
  await using screen = await render(
    <TooltipProvider>
      <div style={{ width: 34, display: "flex" }}>
        <ThreadStatusLabel
          status={{ ...workingStatus, label: "Pending Approval", pulse: false }}
          icon={{ shape: "diamond", style: "solid" }}
        />
      </div>
    </TooltipProvider>,
  );
  await vi.waitFor(() => {
    const label = screen.container.querySelector<HTMLElement>('[role="img"]')!;
    const text = [...label.children].find((child) => child.textContent === "Pending Approval")!;
    const marker = label.querySelector<HTMLElement>("[data-status-shape]")!;
    expect(getComputedStyle(label).overflow).toBe("visible");
    expect(getComputedStyle(marker).overflow).toBe("visible");
    expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    expect(getComputedStyle(text).textOverflow).toBe("ellipsis");
    expect(marker.getBoundingClientRect().width).toBe(6);
    expect(label.getBoundingClientRect().width).toBeLessThanOrEqual(34);
  });
});
