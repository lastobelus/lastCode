import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  fileChipClipboardPath,
  fileChipMenu,
  fileChipShareSource,
  resolveFileChipTarget,
} from "./fileChipMenu";

it("copies native paths from a relative file chip in a Windows workspace", () => {
  const target = resolveFileChipTarget("reports/Device Users.csv", "C:/repo");
  if (!target) throw new Error("File-chip target unavailable");
  expect(fileChipClipboardPath(target, "copy-full-path")).toBe(
    String.raw`C:\repo\reports\Device Users.csv`,
  );
  expect(fileChipClipboardPath(target, "copy-relative-path")).toBe(
    String.raw`reports\Device Users.csv`,
  );
});

describe("resolveFileChipTarget", () => {
  it("resolves a workspace-relative link to both paths", () => {
    expect(resolveFileChipTarget("src/app.ts:12", "/repo")).toEqual({
      fullPath: "/repo/src/app.ts",
      relativePath: "src/app.ts",
    });
  });

  it("resolves home links for navigation and menu actions", () => {
    expect(resolveFileChipTarget("~/.agents/AGENTS.md:314", "/home/maria/repo")).toEqual({
      fullPath: "/home/maria/.agents/AGENTS.md",
    });
    expect(resolveFileChipTarget("~/repo/src/main.ts:12", "/home/maria/repo")).toEqual({
      fullPath: "/home/maria/repo/src/main.ts",
      relativePath: "src/main.ts",
    });
    expect(resolveFileChipTarget("~/.agents/AGENTS.md", "C:\\Users\\maria\\repo")).toEqual({
      fullPath: "C:\\Users\\maria\\.agents\\AGENTS.md",
    });
  });

  it("rejects parent-relative file links that escape the workspace", () => {
    expect(resolveFileChipTarget("../other/file.ts:18", "/repo")).toBeNull();
    expect(resolveFileChipTarget("../report.pdf", "C:\\repo")).toBeNull();
  });

  it.each([
    ["/Users/developer/project", "/Users/developer/report.md"],
    ["/home/developer/project", "/home/developer/report.md"],
    ["C:\\Users\\developer\\project", "C:\\Users\\developer\\report.md"],
    ["C:/Users/developer/project", "C:/Users/developer\\report.md"],
  ])("resolves a home-relative file using the workspace at %s", (cwd, fullPath) => {
    expect(resolveFileChipTarget("~/report.md:18:3", cwd)).toEqual({ fullPath });
  });

  it("keeps a home-relative file's workspace route when it resolves inside the workspace", () => {
    expect(resolveFileChipTarget("~/project/report.md#L18C3", "/home/developer/project")).toEqual({
      fullPath: "/home/developer/project/report.md",
      relativePath: "report.md",
    });
  });

  it("keeps encoded filename colons and percent signs literal when expanding home", () => {
    expect(
      resolveFileChipTarget("~/report%3A12%2520%23one.md:18", "/Users/developer/project"),
    ).toEqual({
      fullPath: "/Users/developer/report:12%20#one.md",
    });
    expect(resolveFileChipTarget("~/report%2520%23one.md:18", "/home/developer/project")).toEqual({
      fullPath: "/home/developer/report%20#one.md",
    });
  });

  it.each([null, "/repo", "/srv/project", "C:\\repo"])("cannot infer home from %s", (cwd) => {
    expect(resolveFileChipTarget("~/report.md", cwd)).toBeNull();
  });

  it("ignores links that are not files or cannot be opened", () => {
    expect(resolveFileChipTarget("https://example.com/app.ts", "/repo")).toBeNull();
    expect(resolveFileChipTarget("~/report.md", "/repo")).toBeNull();
    expect(resolveFileChipTarget("../other/file.ts", null)).toBeNull();
  });
});

describe("file chip downloads", () => {
  const threadId = ThreadId.make("thread-1");

  it("saves a supported home-relative document through its resolved host destination", () => {
    const target = resolveFileChipTarget("~/report.pdf#L12", "/home/developer/project")!;
    expect(fileChipMenu(target).actions).toContainEqual({ id: "save", title: "Save or share" });
    expect(fileChipShareSource(target, threadId)).toEqual({
      name: "report.pdf",
      mimeType: "application/pdf",
      resource: { _tag: "media-file", threadId, path: "/home/developer/report.pdf" },
    });
  });

  it.each([
    [
      "/tmp/maria-counter/maria-counter-final.mp4",
      "/tmp/maria-counter/maria-counter-final.mp4",
      "video/mp4",
    ],
    ["/tmp/take%2520%23one.mp4:12", "/tmp/take%20#one.mp4", "video/mp4"],
    ["/tmp/report.pdf", "/tmp/report.pdf", "application/pdf"],
    ["screens/image.PNG", "/repo/screens/image.PNG", "image/png"],
  ])("offers a host download for %s", (href, path, mimeType) => {
    const target = resolveFileChipTarget(href, "/repo")!;
    expect(fileChipMenu(target).actions).toContainEqual({
      id: "save",
      title: "Save or share",
    });
    expect(fileChipShareSource(target, threadId)).toEqual({
      name: path.split("/").at(-1),
      mimeType,
      resource: { _tag: "media-file", threadId, path },
    });
  });

  it("does not offer downloads the host asset endpoint cannot serve", () => {
    for (const href of ["src/app.ts", "/tmp/archive.zip", "/tmp/clip.mp4.txt"]) {
      const target = resolveFileChipTarget(href, "/repo")!;
      expect(fileChipShareSource(target, threadId)).toBeNull();
      expect(fileChipMenu(target).actions.some(({ id }) => id === "save")).toBe(false);
    }
  });
});
