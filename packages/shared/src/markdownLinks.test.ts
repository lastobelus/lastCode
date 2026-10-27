import { workspaceRelativeFilePath } from "./path.ts";
import { describe, expect, it } from "vite-plus/test";
import { extractMarkdownLinkHrefs, resolveMarkdownFileLinkTarget } from "./markdownLinks.ts";

import {
  inlineCodeFilePathCandidate,
  isMarkdownFileLinkLabel,
  parseMarkdownFileLink,
} from "./markdownLinks.ts";

describe("isMarkdownFileLinkLabel", () => {
  // regression: #15509 descriptive labels are not mistaken for the linked file name
  it.each([
    ["validates the input", "/repo/src/example.ts:12", false],
    ["example.ts:12", "/repo/src/example.ts:12", true],
    ["example.ts:99", "/repo/src/example.ts:12", false],
  ])("classifies %s for %s", (label, href, expected) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(expected);
  });
});

describe("inlineCodeFilePathCandidate", () => {
  // regression: #13909 model ids in inline code do not become file chips
  it.each([
    ["src\\main.ts", "src/main.ts"],
    ["origin/main", null],
    ["z-ai/glm-5.3", null],
    ["share/man/ls.1", "share/man/ls.1"],
    ["src/main.ts/", null],
    ["./patches/", "./patches/"],
  ])("distinguishes file paths from code and hostnames in %s", (source, candidate) => {
    expect(inlineCodeFilePathCandidate(source)).toBe(candidate);
  });
});

describe("parseMarkdownFileLink", () => {
  it.each([
    ["C:%5Crepo%5Cimage.png", "C:\\repo\\image.png"],
    ["</D:/Programme/t3code/ChatMarkdown.tsx:1>", "D:/Programme/t3code/ChatMarkdown.tsx"],
    ["file://localhost/home/me/notes.md", "/home/me/notes.md"],
  ])("recognizes %s as a file", (href, path) => {
    expect(parseMarkdownFileLink(href)?.path).toBe(path);
  });

  it.each(["https://example.com/docs", "/chat/settings#L3", "TODO:12", "patches"])(
    "does not treat %s as a file",
    (href) => {
      expect(parseMarkdownFileLink(href)).toBeNull();
    },
  );

  it("recognizes a relative folder that ends in a slash", () => {
    expect(parseMarkdownFileLink("patches/")).toEqual({ path: "patches/" });
    expect(parseMarkdownFileLink("docs/My%20Folder/")?.path).toBe("docs/My Folder/");
  });

  it("accepts conventional extensionless names with or without a position", () => {
    expect(parseMarkdownFileLink("Makefile")).toEqual({ path: "Makefile" });
    expect(parseMarkdownFileLink("Dockerfile:8")).toEqual({ path: "Dockerfile", line: 8 });
    expect(parseMarkdownFileLink("/srv/app/Makefile")).toEqual({ path: "/srv/app/Makefile" });
  });

  it("reads positions from suffixes and line anchors", () => {
    expect(parseMarkdownFileLink("/Users/julius/project/src/main.ts#L42C7")).toEqual({
      path: "/Users/julius/project/src/main.ts",
      line: 42,
      column: 7,
    });
    expect(parseMarkdownFileLink("file://server/share/src/main.ts#L42C7")).toMatchObject({
      path: "\\\\server\\share\\src\\main.ts",
      line: 42,
      column: 7,
    });
  });
});

describe("workspaceRelativeFilePath", () => {
  // regression: #12449 workspace root links resolve to "."
  it.each([
    ["/repo/project", "/repo/project", "."],
    ["C:/", "c:/", "."],
    ["/repo/project/a.ts", undefined, null],
  ])("relates %s to %s", (path, workspaceRoot, relativePath) => {
    expect(workspaceRelativeFilePath(path, workspaceRoot)).toBe(relativePath);
  });
});

describe("extractMarkdownLinkHrefs", () => {
  it.each([
    ["[".repeat(32_000), []],
    ["[a](<foo)bar> invalid [b](ok)", ["<foo", "ok"]],
    ["[[[nested](src/main.ts) [unfinished", ["src/main.ts"]],
  ])("extracts links from incomplete and nested text", (markdown, hrefs) => {
    expect(extractMarkdownLinkHrefs(markdown)).toEqual(hrefs);
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves a relative folder with a trailing slash against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("patches/", "/repo/project")).toBe(
      "/repo/project/patches/",
    );
    expect(resolveMarkdownFileLinkTarget("patches", "/repo/project")).toBeNull();
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
    expect(resolveMarkdownFileLinkTarget("//cdn.example.com/clip.mp4", "/workspace")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("links a network path only inside the project's share", () => {
    const cwd = "\\\\server\\share";
    expect(resolveMarkdownFileLinkTarget("file://server/share/workspace-image.svg", cwd)).toBe(
      "\\\\server\\share\\workspace-image.svg",
    );
    // Opening these sent the Windows user's NTLM credentials to attacker.test.
    for (const href of ["file://attacker.test/s/x.ts", "\\\\attacker.test\\s\\x.ts"]) {
      expect(resolveMarkdownFileLinkTarget(href, cwd)).toBeNull();
    }
  });

  it("keeps an encoded final space in the absolute target", () => {
    expect(resolveMarkdownFileLinkTarget("/tmp/repo/file.ts%20", "/tmp/repo")).toBe(
      "/tmp/repo/file.ts ",
    );
  });

  it("normalizes slash-prefixed windows drive paths before resolving", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "/D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx:69");
  });

  it("decodes an encoded drive colon in a file uri before dropping its slash", () => {
    expect(resolveMarkdownFileLinkTarget("file:///c%3A/Users/x/shot.png")).toBe(
      "c:/Users/x/shot.png",
    );
  });
});

describe("isMarkdownFileLinkLabel", () => {
  it.each(["README.md ", " README.md", "\nREADME.md", "README.md\u00a0"])(
    "preserves surrounding label whitespace in %j",
    (label) => expect(isMarkdownFileLinkLabel(label, "/repo/README.md")).toBe(false),
  );

  it.each([
    ["<example.ts>", "/repo/example.ts", false],
    ["<example.ts:12>", "/repo/example.ts:12", false],
    ["<example.ts>", "/tmp/%3Cexample.ts%3E", true],
    ["<example.ts>:12", "/tmp/%3Cexample.ts%3E:12", true],
  ])("preserves literal angle brackets in %s", (label, href, compact) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(compact);
  });

  it.each([
    ["README.md#L0", "/tmp/README.md%23L0", true],
    ["README.md#L0", "/tmp/README.md#L0", false],
    ["README.md#L12C0", "/tmp/README.md%23L12C0", true],
  ])("distinguishes literal zero anchors in %s", (label, href, compact) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(compact);
  });

  it.each([
    "example.ts:0",
    "example.ts:12:0",
    "example.ts#L0",
    "example.ts#L12C0",
    "example.ts:00",
  ])("preserves invalid explicit position in %s", (label) =>
    expect(isMarkdownFileLinkLabel(label, "/repo/example.ts:12")).toBe(false),
  );

  it.each([
    ["clip#one.mp4#L12", "/tmp/clip%23one.mp4#L12", true],
    ["clip?one.mp4#L12C4", "/tmp/clip%3Fone.mp4:12:4", true],
    ["clip#one.mp4#L12", "/tmp/clip%23one.mp4:99", false],
    ["clip?one.mp4#L12C4", "/tmp/clip%3Fone.mp4:12:8", false],
    ["clip#one.mp4#L12", "/tmp/clip%23one.mp4", false],
    ["CLIP#ONE.mp4#l12", "C:/clips/clip%23one.mp4:12", true],
    ["clip#one.mp4#L12", "/tmp/clip%23one.mp4%23L12", true],
    ["clip#one.mp4#details", "/tmp/clip%23one.mp4", false],
  ])("matches trailing position anchors on literal filename %s", (label, href, compact) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(compact);
  });

  it.each([
    ["clip#one.mp4:12", "/tmp/clip%23one.mp4:12", true],
    ["clip?one.mp4:12:4", "/tmp/clip%3Fone.mp4:12:4", true],
    ["clip#one.mp4:12", "/tmp/clip%23one.mp4:99", false],
    ["clip?one.mp4:12:4", "/tmp/clip%3Fone.mp4:12:8", false],
    ["clip#one.mp4:12", "/tmp/clip%23one.mp4", false],
    ["CLIP#ONE.mp4:12", "C:/clips/clip%23one.mp4:12", true],
  ])("matches positions on literal filename %s", (label, href, compact) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(compact);
  });

  it.each([
    ["clip#one.mp4", "/tmp/clip%23one.mp4#t=2"],
    ["clip?one.mp4", "/tmp/clip%3Fone.mp4"],
    ["./clips/clip#one.mp4", "/tmp/clips/clip%23one.mp4"],
    ["CLIP#ONE.mp4", "C:/clips/clip%23one.mp4"],
  ])("keeps literal filename delimiters compact in %s", (label, href) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(true);
  });

  it.each([
    ["README.md#installation", "/repo/README.md"],
    ["README.md?mode=raw", "/repo/README.md"],
    ["README.md?mode=raw#L12", "/repo/README.md:12"],
    ["file:///repo/README.md#installation", "/repo/README.md"],
    ["README.md#installation", "/repo/README.md#installation"],
    ["README.md#", "/repo/README.md"],
  ])("preserves non-position suffixes in %s", (label, href) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(false);
  });

  it.each([
    ["C:\\Repo\\src\\Example.ts", "c:\\repo\\src\\example.ts", true],
    ["SRC/Example.ts:12", "c:/repo/src/example.ts:12", true],
    ["Example.ts", "file:///C:/repo/example.ts", true],
    ["Example.ts:99", "c:/repo/example.ts:12", false],
    ["/Repo/Example.ts", "/repo/example.ts", false],
    ["Example.ts", "/repo/example.ts", false],
  ])("respects filesystem casing for %s against %s", (label, href, compact) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(compact);
  });

  it.each([
    ["example.ts:99", "/repo/example.ts:12", false],
    ["example.ts:12:8", "/repo/example.ts:12:4", false],
    ["example.ts:12", "/repo/example.ts", false],
    ["example.ts:12:4", "/repo/example.ts:12", false],
    ["file:///repo/example.ts#L99", "/repo/example.ts:12", false],
    ["file:///repo/example.ts#L12C8", "/repo/example.ts:12:4", false],
    ["example.ts", "/repo/example.ts:12:4", true],
    ["example.ts:12", "/repo/example.ts:12:4", true],
    ["example.ts:12:4", "/repo/example.ts:12:4", true],
    ["file:///repo/example.ts#L12C4", "/repo/example.ts:12:4", true],
  ])("matches explicit positions in %s against %s", (label, href, compact) => {
    expect(isMarkdownFileLinkLabel(label, href)).toBe(compact);
  });

  it.each([
    "example.ts",
    "example.ts:12",
    "src/example.ts",
    "./src/example.ts:12",
    "/repo/src/example.ts",
    "file:///repo/src/example.ts#L12",
    "",
  ])("keeps destination label %s compact", (label) =>
    expect(isMarkdownFileLinkLabel(label, "/repo/src/example.ts:12")).toBe(true),
  );
  it.each(["validates the input", "the example.ts", "other.ts", "src/other.ts"])(
    "preserves authored label %s",
    (label) => expect(isMarkdownFileLinkLabel(label, "/repo/src/example.ts:12")).toBe(false),
  );
  it.each(["favicons", "favicons/", "/tmp/favicons/"])(
    "keeps directory label %s compact",
    (label) => {
      expect(isMarkdownFileLinkLabel(label, "/tmp/favicons/")).toBe(true);
    },
  );
  it("recognizes Windows paths and encoded destinations", () => {
    expect(isMarkdownFileLinkLabel("src\\example.ts:12", "C:\\repo\\src\\example.ts:12")).toBe(
      true,
    );
    expect(isMarkdownFileLinkLabel("my file.ts", "/repo/my%20file.ts#L12")).toBe(true);
  });
});

it.each(["https://example.com/docs", ""])("keeps an empty authored label on %s", (href) => {
  expect(isMarkdownFileLinkLabel("", href)).toBe(false);
});
