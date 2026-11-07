import { describe, expect, it } from "vite-plus/test";
import { prepareEnrichedMarkdown } from "./enrichedMarkdown";
import { parseMarkdownDocument } from "./markdownDocument";

describe("Enriched authored file labels", () => {
  it("keeps descriptions, formatting, positions, and the original link destination", () => {
    const source = "Read [**the guide** and `examples`](/workspace/guide.md:12) now.";
    const result = prepareEnrichedMarkdown(source);
    expect(result.markdown).toBe(
      "Read [**the guide** and `examples` (guide.md · L12)](/workspace/guide.md:12) now.",
    );
    expect([...result.authoredFileLinks]).toEqual(["/workspace/guide.md:12"]);
  });

  it("lets matching file labels retain native file pills", () => {
    const source = "[guide.md:12](/workspace/guide.md:12) [guide.md](/workspace/guide.md)";
    expect(prepareEnrichedMarkdown(source)).toEqual({
      markdown: source,
      authoredFileLinks: new Set(),
    });
  });

  it("keeps images, emphasis, and heading context inside their parent file link", () => {
    const source = "## **[![Preview](/workspace/image.png) details](/workspace/guide.md)**";
    const result = prepareEnrichedMarkdown(source);
    expect(result.markdown).toBe(
      "## **[![Preview](/workspace/image.png) details (guide.md)](/workspace/guide.md)**",
    );
    expect([...result.authoredFileLinks]).toEqual(["/workspace/guide.md"]);
  });

  it("does not add destination labels to external image links or change code", () => {
    const source = "[![Preview](image.png)](https://example.com) `&amp; [guide](guide.md)`";
    expect(prepareEnrichedMarkdown(source).markdown).toBe(source);
  });

  it("compares named entities once while leaving code labels literal", () => {
    const source =
      "[caf&eacute;.md](/workspace/caf%C3%A9.md) [`caf&eacute;.md`](/workspace/caf%C3%A9.md)";
    const result = prepareEnrichedMarkdown(source);
    expect(result.markdown).toBe(
      "[caf&eacute;.md](/workspace/caf%C3%A9.md) [`caf&eacute;.md` (café.md)](/workspace/caf%C3%A9.md)",
    );
    expect(prepareEnrichedMarkdown("[&amp;eacute;.md](/workspace/caf%C3%A9.md)").markdown).toBe(
      "[&amp;eacute;.md (café.md)](/workspace/caf%C3%A9.md)",
    );
  });

  it.each(["[guide][target]", "[target][]", "[target]"])(
    "preserves reference destination and title for %s",
    (label) => {
      const result = prepareEnrichedMarkdown(`${label}\n\n[target]: /workspace/guide.md "Title"`);
      const paragraph = parseMarkdownDocument(result.markdown).children[0];
      expect(paragraph?.type).toBe("paragraph");
      if (paragraph?.type !== "paragraph") throw new Error("Expected paragraph");
      expect(paragraph.children[0]).toMatchObject({
        type: "link",
        url: "/workspace/guide.md",
        title: "Title",
      });
      expect(result.markdown).toContain('(guide.md)](</workspace/guide.md> "Title")');
    },
  );

  it("escapes destination filename punctuation without altering authored whitespace", () => {
    const result = prepareEnrichedMarkdown("[  guide  ](</workspace/a[1]&copy;.md>)");
    expect(result.markdown).toBe("[  guide   (a\\[1\\]©.md)](</workspace/a[1]&copy;.md>)");
  });

  it("decodes HTML image attributes once before preserving their enclosing link", () => {
    const result = prepareEnrichedMarkdown(
      '[<img src="/workspace/a&amp;copy;.png" alt="caf&eacute;" />](/workspace/guide.md)',
    );
    expect(result.markdown).toBe(
      "[![café](</workspace/a\\&copy;.png>) (guide.md)](/workspace/guide.md)",
    );
  });
});
