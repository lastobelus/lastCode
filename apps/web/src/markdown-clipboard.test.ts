import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { serializeRenderedMarkdownFragment } from "./markdown-clipboard";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

class FakeText {
  readonly nodeType = TEXT_NODE;
  readonly childNodes: ReadonlyArray<never> = [];

  constructor(readonly textContent: string) {}
}

class FakeElement {
  readonly nodeType = ELEMENT_NODE;
  checked = false;
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly classList = {
    contains: (name: string) => this.classNames.includes(name),
  };

  constructor(
    readonly tagName: string,
    private readonly classNames: ReadonlyArray<string> = [],
    private readonly attributes: Readonly<Record<string, string>> = {},
  ) {}

  get localName(): string {
    return this.tagName.toLowerCase();
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  get children(): ReadonlyArray<FakeElement> {
    return this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement);
  }

  append(...children: Array<FakeElement | FakeText>): this {
    this.childNodes.push(...children);
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attributes, name);
  }

  closest(): FakeElement | null {
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...((
        selector.startsWith("[")
          ? child.hasAttribute(selector.slice(1, -1))
          : child.tagName === selector.toUpperCase()
      )
        ? [child]
        : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  querySelector(selector: string): FakeElement | null {
    if (selector.includes(", ")) {
      for (const part of selector.split(", ")) {
        const match = this.querySelector(part);
        if (match) return match;
      }
      return null;
    }
    const childOnly = selector.startsWith(":scope > ");
    const [target, ...rest] = (childOnly ? selector.slice(":scope > ".length) : selector).split(
      " > ",
    );
    const matches = (element: FakeElement): boolean => {
      if (target === 'input[type="checkbox"]') {
        return element.tagName === "INPUT" && element.getAttribute("type") === "checkbox";
      }
      if (target?.startsWith("[")) return element.hasAttribute(target.slice(1, -1));
      return element.tagName === target?.toUpperCase();
    };
    const search = (parent: FakeElement): FakeElement | null => {
      for (const child of parent.childNodes) {
        if (!(child instanceof FakeElement)) continue;
        if (matches(child)) {
          if (rest.length === 0) return child;
          const nested = child.querySelector(`:scope > ${rest.join(" > ")}`);
          if (nested) return nested;
        }
        if (!childOnly) {
          const nested = search(child);
          if (nested) return nested;
        }
      }
      return null;
    };
    return search(this);
  }
}

function asNode(element: FakeElement): Node {
  return element as unknown as Node;
}

function shikiCodeLine(text: string): FakeElement {
  const token = new FakeElement("SPAN").append(new FakeText(text));
  return new FakeElement("SPAN", ["line"]).append(token);
}

function renderedCodeBlock(lines: ReadonlyArray<string>): FakeElement {
  const code = new FakeElement("CODE");
  lines.forEach((line, index) => {
    if (index > 0) code.append(new FakeText("\n"));
    code.append(shikiCodeLine(line));
  });
  return new FakeElement("DIV", ["chat-markdown-codeblock"]).append(
    new FakeElement("DIV", ["chat-markdown-codeblock-header", "select-none"]).append(
      new FakeText("sh"),
    ),
    new FakeElement("DIV", ["chat-markdown-shiki"]).append(new FakeElement("PRE").append(code)),
  );
}

describe("serializeRenderedMarkdownFragment", () => {
  it.each([
    ["  ", "  "],
    ["   ", "   "],
    [" ", ""],
    ["\t", ""],
    [" \t", ""],
  ])("preserves hard breaks while tidying trailing whitespace %j", (trailing, expected) => {
    const container = new FakeElement("DIV").append(
      new FakeElement("BUTTON", [], {
        "data-markdown-copy": `[src/${trailing}\nexample.ts](/repo/src/example.ts)`,
      }),
    );
    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      `[src/${expected}\nexample.ts](/repo/src/example.ts)`,
    );
  });

  it("copies a popover context reference once, without its details or nested label", () => {
    const reference = "[Review comment](t3-context://v1/review-comment/review-1)";
    const container = new FakeElement("DIV").append(
      new FakeText("Fix "),
      new FakeElement("BUTTON", [], { "data-markdown-copy": reference }).append(
        new FakeElement("SPAN", [], { "data-markdown-copy": reference }).append(
          new FakeText("Review comment"),
        ),
      ),
      new FakeText(" please"),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(`Fix ${reference} please`);
  });

  it.each(["A", "BUTTON"])(
    "retains file destinations when a complete %s label has a break",
    (tag) => {
      const source = "[src/\\\nexample.ts](/repo/src/example.ts)";
      const attributes = {
        "data-markdown-copy": source,
        "data-markdown-copy-text": "src/\nexample.ts (example.ts)",
      };
      const complete = new FakeElement("DIV").append(
        new FakeElement(tag, [], attributes).append(
          new FakeText("src/"),
          new FakeElement("BR"),
          new FakeText("example.ts (example.ts)"),
        ),
      );
      expect(serializeRenderedMarkdownFragment(asNode(complete))).toBe(source);
      const partial = new FakeElement("DIV").append(
        new FakeElement(tag, [], attributes).append(new FakeText("example.ts")),
      );
      expect(serializeRenderedMarkdownFragment(asNode(partial))).toBe("example.ts");
    },
  );

  it.each(["A", "BUTTON"])("copies only selected descriptive label text in %s wrappers", (tag) => {
    const attributes = {
      "data-markdown-copy": "[validates the input](/repo/example.ts)",
      "data-markdown-copy-text": "validates the input (example.ts)",
    };
    const leading = new FakeElement("DIV").append(
      new FakeText("It "),
      new FakeElement(tag, [], attributes).append(
        new FakeElement("STRONG").append(new FakeText("valid")),
      ),
    );
    expect(serializeRenderedMarkdownFragment(asNode(leading))).toBe("It **valid**");

    const trailing = new FakeElement("DIV").append(
      new FakeElement(tag, [], attributes).append(new FakeText("input (example.ts)")),
      new FakeText(" afterward"),
    );
    expect(serializeRenderedMarkdownFragment(asNode(trailing))).toBe(
      "input (example.ts) afterward",
    );

    const complete = new FakeElement("DIV").append(
      new FakeElement(tag, [], attributes).append(new FakeText("validates the input (example.ts)")),
    );
    expect(serializeRenderedMarkdownFragment(asNode(complete))).toBe(
      attributes["data-markdown-copy"],
    );
  });

  it.each(["IMG", "VIDEO", "SPAN"])(
    "validates partial and complete selections with rendered %s media",
    (tag) => {
      const attributes = {
        "data-markdown-copy": "[![diagram](preview.png)](/repo/example.ts)",
        "data-markdown-copy-text": " (example.ts)",
        "data-markdown-copy-images": "1",
      };
      const partial = new FakeElement("DIV").append(
        new FakeElement("A", [], attributes).append(new FakeText(" (example.ts)")),
      );
      expect(serializeRenderedMarkdownFragment(asNode(partial))).toBe("(example.ts)");
      const complete = new FakeElement("DIV").append(
        new FakeElement("A", [], attributes).append(
          new FakeElement("SPAN", [], { "data-markdown-copy-media": "" }).append(
            new FakeElement("SPAN", [], { "data-markdown-copy-media-start": "" }),
            new FakeElement(tag, [], { alt: "diagram", src: "preview.png" }).append(
              ...(tag === "SPAN" ? [new FakeText("Image unavailable · diagram")] : []),
            ),
            new FakeElement("SPAN", [], { "data-markdown-copy-media-end": "" }),
          ),
          new FakeText(" (example.ts)"),
        ),
      );
      expect(serializeRenderedMarkdownFragment(asNode(complete))).toBe(
        attributes["data-markdown-copy"],
      );
    },
  );

  it.each(["start", "end", "both"])(
    "accepts complete fallback text without %s markers",
    (missing) => {
      const text = "Image unavailable · diagram";
      const source = "[![diagram](preview.png)](/repo/example.ts)";
      const makeFragment = (selected: string) =>
        new FakeElement("DIV").append(
          new FakeElement("A", [], {
            "data-markdown-copy": source,
            "data-markdown-copy-text": " (example.ts)",
            "data-markdown-copy-images": "1",
          }).append(
            new FakeElement("SPAN", [], { "data-markdown-copy-media": "" }).append(
              ...(missing === "end"
                ? [new FakeElement("SPAN", [], { "data-markdown-copy-media-start": "" })]
                : []),
              new FakeElement("SPAN", [], {
                "data-markdown-copy-media-text": text,
                "data-markdown-copy": "![diagram](preview.png)",
              }).append(new FakeText(selected)),
              ...(missing === "start"
                ? [new FakeElement("SPAN", [], { "data-markdown-copy-media-end": "" })]
                : []),
            ),
            new FakeText(" (example.ts)"),
          ),
        );
      expect(serializeRenderedMarkdownFragment(asNode(makeFragment(text)))).toBe(source);
      expect(serializeRenderedMarkdownFragment(asNode(makeFragment("available · diagram")))).toBe(
        "available · diagram (example.ts)",
      );
    },
  );

  it("does not restore a link when selection starts inside fallback media text", () => {
    const fragment = new FakeElement("DIV").append(
      new FakeElement("A", [], {
        "data-markdown-copy": "[![diagram](preview.png)](/repo/example.ts)",
        "data-markdown-copy-text": " (example.ts)",
        "data-markdown-copy-images": "1",
      }).append(
        new FakeElement("SPAN", [], { "data-markdown-copy-media": "" }).append(
          new FakeElement("SPAN", [], { "data-markdown-copy": "![diagram](preview.png)" }).append(
            new FakeText("available · diagram"),
          ),
          new FakeElement("SPAN", [], { "data-markdown-copy-media-end": "" }),
        ),
        new FakeText(" (example.ts)"),
      ),
    );
    expect(serializeRenderedMarkdownFragment(asNode(fragment))).toBe(
      "available · diagram (example.ts)",
    );
  });

  beforeEach(() => {
    vi.stubGlobal("Node", { TEXT_NODE, ELEMENT_NODE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies the complete quote, source, and comment instead of the comment-only chip label", () => {
    const citation = {
      version: 1 as const,
      environmentId: EnvironmentId.make("environment-one"),
      threadId: ThreadId.make("thread-one"),
      messageId: MessageId.make("assistant-one"),
      text: "A complete quote, including the part hidden by the chip preview.",
      comment: "What does this mean?\nPlease expand on the hidden part.",
      start: 0,
      end: 66,
      prefix: "",
      suffix: "",
    };
    const anchor = new FakeElement("A", [], {
      "data-markdown-copy": serializeAssistantCitation(citation),
      href: "/environment-one/thread-one#citation",
    }).append(new FakeText("What does this mean?…"));
    const chip = new FakeElement("SPAN", [], {
      "data-markdown-copy": serializeAssistantCitation(citation),
    }).append(anchor, new FakeElement("BUTTON").append(new FakeText("Edit comment")));
    const container = new FakeElement("DIV").append(new FakeText("Explain "), chip);
    const copied = serializeRenderedMarkdownFragment(asNode(container));
    expect(copied).toBe(`Explain ${serializeAssistantCitation(citation)}`);
    expect(collectAssistantCitations(copied).map((entry) => entry.citation)).toEqual([citation]);
  });

  it("keeps a multi-line code selection plain instead of inline-wrapping it", () => {
    const code = new FakeElement("CODE").append(new FakeText("first line\nsecond line"));
    const container = new FakeElement("DIV").append(code);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("first line\nsecond line");
  });

  it("keeps fences when a bare list item sits alongside the code block", () => {
    const container = new FakeElement("DIV").append(
      new FakeElement("UL").append(new FakeElement("LI")),
      renderedCodeBlock(["pnpm test"]),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("-\n\n```\npnpm test\n```");
  });

  it("omits fences when a selection past the last line drags in the whole code block", () => {
    const container = new FakeElement("DIV").append(
      renderedCodeBlock(["printf '%s' 'TOKEN' | gh secret set CLOUDFLARE_API_TOKEN"]),
      new FakeText("\n"),
      new FakeElement("P").append(new FakeText("")),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "printf '%s' 'TOKEN' | gh secret set CLOUDFLARE_API_TOKEN",
    );
  });
});
