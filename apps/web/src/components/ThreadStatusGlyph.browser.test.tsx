import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { LastCodeStatusIcon } from "@t3tools/contracts/settings";
import "../index.css";
import { ThreadStatusGlyph } from "./ThreadStatusGlyph";
import { configurableThreadStatuses } from "./Sidebar.logic";

const workingStatus = configurableThreadStatuses.find((status) => status.label === "Working")!;
import { ThreadStatusLabel } from "./ThreadStatusIndicators";
import { TooltipProvider } from "./ui/tooltip";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function raster(icon: LastCodeStatusIcon) {
  await act(() => root.render(<ThreadStatusGlyph icon={icon} dotClass={workingStatus.dotClass} />));
  const marker = host.querySelector<HTMLElement>("[data-status-shape] > span")!;
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
    for (const style of shape === "circle"
      ? (["open", "outline-fill"] as const)
      : (["open", "solid", "outline-fill"] as const)) {
      const { data } = await raster({ shape, style });
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
      expect(Math.max(...xs) - Math.min(...xs) + 1).toBeCloseTo(width * 20, -1);
      expect(Math.max(...ys) - Math.min(...ys) + 1).toBeCloseTo(height * 20, -1);
      const centerAlpha = data[(90 * 180 + 90) * 4 + 3];
      expect(centerAlpha).toBe(style === "open" ? 0 : style === "solid" ? 255 : 128);
      expect(Math.max(...data.filter((_, index) => index % 4 === 3))).toBe(255);
    }
  },
);

it("preserves the dot color and compact 14px slot for every shape", async () => {
  const status = {
    ...workingStatus,
    pulse: false,
  };
  for (const shape of ["triangle", "triangle-right", "square", "diamond", "circle"] as const) {
    await act(() =>
      root.render(
        <TooltipProvider>
          <ThreadStatusLabel status={status} compact icon={{ shape, style: "solid" }} />
        </TooltipProvider>,
      ),
    );
    const slot = host.querySelector<HTMLElement>('[role="img"]')!;
    const reference = host.querySelector<HTMLElement>("[data-status-shape]")!;
    const marker = reference.firstElementChild!;
    expect(slot.getBoundingClientRect().width).toBe(14);
    expect(slot.getBoundingClientRect().height).toBe(14);
    expect(reference.getBoundingClientRect().width).toBe(6);
    expect(getComputedStyle(reference).overflow).toBe("visible");
    expect(getComputedStyle(marker).backgroundColor).not.toBe(getComputedStyle(slot).color);
    expect(slot.getAttribute("aria-label")).toBe("Working");
  }
});
