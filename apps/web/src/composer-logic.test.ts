import { resolveComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import { filterComposerPullRequestMatches } from "@t3tools/shared/composerPullRequestMatches";
import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  expandAssistantCitationsForProvider,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import {
  collapseExpandedComposerCursor,
  composerSubmissionIntentForKey,
  detectComposerTrigger,
  formatAssistantCitationForComposer,
  parseStandaloneComposerSlashCommand,
  parseThreadAnnotationSlashCommand,
  replaceTextRange,
} from "./composer-logic";
import { formatTerminalContextReference } from "./lib/terminalContext";

const terminalReference = formatTerminalContextReference({
  id: "ctx-1",
  terminalLabel: "Terminal 1",
  lineStart: 3,
  lineEnd: 4,
});

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
  text: "Keep Unicode 👋 and punctuation (here).",
  start: 3,
  end: 40,
  prefix: "前: ",
  suffix: " 後",
};
const citationSource = serializeAssistantCitation(citation).replaceAll("+", "%20");

describe("formatAssistantCitationForComposer", () => {
  it.each([undefined, "", " \n\t "])(
    "keeps citation-only insertion for a blank comment %j",
    (comment) => {
      expect(formatAssistantCitationForComposer(citation, comment)).toBe(
        `${serializeAssistantCitation(citation)} `,
      );
    },
  );

  it("binds a multiline comment to its citation without adding standalone prompt text", () => {
    const comment = 'What does "keep" mean? 👋\n  Please show an example.';
    const text = formatAssistantCitationForComposer(citation, `  ${comment}\n`);
    const boundCitation = { ...citation, comment };
    expect(text).toBe(`${serializeAssistantCitation(boundCitation)} `);
    expect(collectAssistantCitations(text).map((entry) => entry.citation)).toEqual([boundCitation]);
    expect(expandAssistantCitationsForProvider(text)).toMatch(/^\[assistant-quote-1\] \n\n/);
  });
});

describe("composerSubmissionIntentForKey", () => {
  const input = {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    platform: "Linux",
    isMobileViewport: false,
    isDraftThread: false,
  };
  const enter = { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

  it.each([
    ["enter", "one line", false, "foreground"],
    ["enter", "two\nlines", false, "foreground"],
    ["mod-enter-multiline", "one line", false, "foreground"],
    ["mod-enter-multiline", "two\nlines", false, null],
    ["mod-enter-multiline", "two\nlines", true, "foreground"],
    ["mod-enter", "one line", false, null],
    ["mod-enter", "one line", true, "foreground"],
  ] as const)("honors %s for %j", (sendShortcut, prompt, ctrlKey, expected) => {
    expect(
      composerSubmissionIntentForKey({
        ...input,
        event: { ...enter, ctrlKey },
        sendShortcut,
        prompt,
      }),
    ).toBe(expected);
  });

  it.each(["MacIntel", "Win32", "Linux"])("uses the configured actions on %s", (platform) => {
    const modEnter = {
      ...enter,
      metaKey: platform === "MacIntel",
      ctrlKey: platform !== "MacIntel",
    };
    for (const sendShortcut of ["enter", "mod-enter", "mod-enter-multiline"] as const) {
      const running = { ...input, platform, sendShortcut, prompt: "two\nlines", isRunning: true };
      const intent = composerSubmissionIntentForKey({ ...running, event: modEnter });
      expect(intent).toBe("alternate");
      for (const activeTurnDefault of ["queue", "steer"] as const) {
        expect(
          resolveComposerDispatchMode({
            running: true,
            alternateModifier: intent === "alternate",
            activeTurnDefault,
          }),
        ).toBe(activeTurnDefault === "queue" ? "steer" : "queue");
      }
      expect(
        composerSubmissionIntentForKey({
          ...input,
          platform,
          sendShortcut,
          isDraftThread: true,
          event: { ...modEnter, altKey: true },
        }),
      ).toBe("background");
      expect(
        composerSubmissionIntentForKey({
          ...input,
          platform,
          sendShortcut,
          event: { ...modEnter, altKey: true },
        }),
      ).toBe("background");
      expect(
        composerSubmissionIntentForKey({
          ...input,
          platform,
          sendShortcut,
          isDraftThread: true,
          event: modEnter,
        }),
      ).toBe("background");
      expect(
        composerSubmissionIntentForKey({ ...running, event: { ...enter, shiftKey: true } }),
      ).toBeNull();
    }
  });

  it("leaves queued-message steering on Mod+Shift+Enter outside a draft", () => {
    expect(
      composerSubmissionIntentForKey({
        ...input,
        isRunning: true,
        event: { ...enter, ctrlKey: true, shiftKey: true },
      }),
    ).toBeNull();
  });

  it("does not start a background thread with the queued-message shortcut", () => {
    expect(
      composerSubmissionIntentForKey({
        ...input,
        isDraftThread: true,
        event: { ...enter, ctrlKey: true, shiftKey: true },
      }),
    ).toBeNull();
  });

  it.each([
    ["mod+arrowup", { key: "ArrowUp", ctrlKey: true }],
    ["shift+tab", { key: "Tab", shiftKey: true }],
  ] as const)("accepts a remapped %s action", (key, event) => {
    const keybindings = mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([
        { key, command: "composer.sendBackground", when: "composerFocus && draftThreadRoute" },
      ]),
    );
    expect(
      composerSubmissionIntentForKey({
        ...input,
        keybindings,
        isDraftThread: true,
        event: { ...enter, ...event },
      }),
    ).toBe("background");
  });

  it("uses remapped keys and removes the old action bindings", () => {
    const keybindings = mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([
        {
          key: "alt+q",
          command: "composer.sendAlternate",
          when: "composerFocus && turnRunning",
        },
        {
          key: "alt+b",
          command: "composer.sendBackground",
          when: "composerFocus && draftThreadRoute",
        },
      ]),
    );
    const custom = { ...input, keybindings };
    expect(
      composerSubmissionIntentForKey({
        ...custom,
        isRunning: true,
        event: { ...enter, key: "q", altKey: true },
      }),
    ).toBe("alternate");
    expect(
      composerSubmissionIntentForKey({
        ...custom,
        isDraftThread: true,
        event: { ...enter, key: "b", altKey: true },
      }),
    ).toBe("background");
    expect(
      composerSubmissionIntentForKey({
        ...custom,
        isRunning: true,
        event: { ...enter, ctrlKey: true },
      }),
    ).toBe("foreground");
    expect(
      composerSubmissionIntentForKey({
        ...custom,
        isDraftThread: true,
        event: { ...enter, ctrlKey: true, shiftKey: true },
      }),
    ).toBeNull();
    expect(
      composerSubmissionIntentForKey({ ...custom, event: { ...enter, key: "b", altKey: true } }),
    ).toBeNull();
  });

  it.each([
    { isMobileViewport: true },
    { event: { ...enter, isComposing: true } },
    { event: { ...enter, keyCode: 229 } },
    { event: { ...enter, repeat: true } },
  ])("does not submit with %j", (override) => {
    expect(composerSubmissionIntentForKey({ ...input, event: enter, ...override })).toBeNull();
  });
});

describe("detectComposerTrigger", () => {
  it.each(["Use ", "Use\t", "Use\n  "])("detects inline slash skills after %j", (prefix) => {
    const text = `${prefix}/skill:review later`;
    const cursor = `${prefix}/skill:review`.length;
    expect(detectComposerTrigger(text, cursor)).toEqual({
      kind: "slash-command",
      query: "skill:review",
      rangeStart: prefix.length,
      rangeEnd: cursor,
    });
  });

  it.each(["Use /", "Use /review"])("detects the inline slash token in %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: text.slice(5),
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each(["Use/review", "https://example.com/review", "Use /review "])(
    "does not trigger for %j",
    (text) => expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it("detects @path trigger at cursor", () => {
    const text = "Please check @src/com";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "path",
      query: "src/com",
      rangeStart: "Please check ".length,
      rangeEnd: text.length,
    });
  });

  it("detects slash command token while typing command name", () => {
    const text = "/mo";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "mo",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps /model as a slash command item", () => {
    const text = "/model";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "model",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("does not keep a subcommand trigger active after /model arguments", () => {
    const text = "/model spark";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toBeNull();
  });

  it("detects non-model slash commands while typing", () => {
    const text = "/pl";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "pl",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps slash command detection active for provider commands", () => {
    const text = "/rev";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "detects %sskill trigger at cursor",
    (prefix) => {
      const text = `Use ${prefix}gh-fi`;
      const trigger = detectComposerTrigger(text, text.length);

      expect(trigger).toEqual({
        kind: "skill",
        query: "gh-fi",
        rangeStart: "Use ".length,
        rangeEnd: text.length,
      });
    },
  );

  it("detects a pull request number at a token boundary", () => {
    const text = "Compare this with #8737";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "pull-request",
      query: "8737",
      rangeStart: "Compare this with ".length,
      rangeEnd: text.length,
    });
  });

  it("opens pull request completion from a bare hash", () => {
    const text = "Compare with #";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "pull-request",
      query: "",
      rangeStart: "Compare with ".length,
      rangeEnd: text.length,
    });
  });

  it("detects a one-word pull request search", () => {
    const text = "Compare with #composer";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "pull-request",
      query: "composer",
      rangeStart: "Compare with ".length,
      rangeEnd: text.length,
    });
  });

  it("supports hyphenated pull request search terms", () => {
    const text = "Find #inline-context";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "pull-request",
      query: "inline-context",
      rangeStart: "Find ".length,
      rangeEnd: text.length,
    });
  });

  it("does not keep pull request completion active for headings or embedded hashes", () => {
    expect(detectComposerTrigger("# Heading", "# Heading".length)).toBeNull();
    expect(detectComposerTrigger("issue#123", "issue#123".length)).toBeNull();
  });

  it("detects @path trigger in the middle of existing text", () => {
    // User typed @ between "inspect " and "in this sentence"
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).toEqual({
      kind: "path",
      query: "",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterAt,
    });
  });

  it("detects @path trigger with query typed mid-text", () => {
    // User typed @sr between "inspect " and "in this sentence"
    const text = "Please inspect @srin this sentence";
    const cursorAfterQuery = "Please inspect @sr".length;

    const trigger = detectComposerTrigger(text, cursorAfterQuery);
    expect(trigger).toEqual({
      kind: "path",
      query: "sr",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterQuery,
    });
  });

  it("detects trigger with true cursor even when regex-based mention detection would false-match", () => {
    // MENTION_TOKEN_REGEX can false-match plain text like "@in" as a mention.
    // The fix bypasses it by computing the expanded cursor from the Lexical node tree.
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).not.toBeNull();
    expect(trigger?.kind).toBe("path");
    expect(trigger?.query).toBe("");
  });
});

describe("filterComposerPullRequestMatches", () => {
  const entries = [
    {
      number: 7,
      projectId: "project-1",
      repository: "t3tools/t3code",
      updatedAt: "2026-09-01T12:00:00.000Z",
    },
    {
      number: 8987,
      projectId: "project-1",
      repository: "T3Tools/T3Code",
      updatedAt: "2026-09-03T12:00:00.000Z",
    },
    {
      number: 27,
      projectId: "project-1",
      repository: "t3tools/t3code",
      updatedAt: "2026-09-02T12:00:00.000Z",
    },
    {
      number: 27,
      projectId: "project-1",
      repository: "t3tools/t3code",
      updatedAt: "2026-09-01T13:00:00.000Z",
    },
    {
      number: 70,
      projectId: "project-2",
      repository: "t3tools/other",
      updatedAt: "2026-09-04T12:00:00.000Z",
    },
  ];

  it("matches and de-duplicates number fragments within one repository, exact match first", () => {
    expect(
      filterComposerPullRequestMatches({
        entries,
        projectId: "project-1",
        repository: "t3tools/t3code",
        query: "7",
        limit: 10,
      }).map((entry) => entry.number),
    ).toEqual([7, 8987, 27]);
  });

  it("keeps an older exact match when newer substring matches would fill the limit", () => {
    const exact = {
      number: 7,
      projectId: "project-1",
      repository: "t3tools/t3code",
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    const newerSubstringMatches = Array.from({ length: 12 }, (_unused, index) => ({
      number: 700 + index,
      projectId: "project-1",
      repository: "t3tools/t3code",
      updatedAt: `2026-09-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
    }));
    const matches = filterComposerPullRequestMatches({
      entries: [...newerSubstringMatches, exact],
      projectId: "project-1",
      repository: "t3tools/t3code",
      query: "7",
      limit: 10,
    });
    expect(matches[0]?.number).toBe(7);
    expect(matches).toHaveLength(10);
  });

  it("uses an empty query for a capped recent list", () => {
    expect(
      filterComposerPullRequestMatches({
        entries,
        projectId: "project-1",
        repository: "t3tools/t3code",
        query: "",
        limit: 2,
      }).map((entry) => entry.number),
    ).toEqual([8987, 27]);
  });
});

describe("replaceTextRange", () => {
  it("replaces a text range and returns new cursor", () => {
    const replaced = replaceTextRange("hello @src", 6, 10, "");
    expect(replaced).toEqual({
      text: "hello ",
      cursor: 6,
    });
  });
});

describe("collapseExpandedComposerCursor", () => {
  it("keeps cursor unchanged when no mention segment is present", () => {
    expect(collapseExpandedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps expanded mention cursor back to collapsed cursor", () => {
    const text = "what's in my @AGENTS.md fsfdas";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursorAfterMention = "what's in my @AGENTS.md ".length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterMention)).toBe(
      collapsedCursorAfterMention,
    );
  });

  it("maps expanded quoted mention cursor back to collapsed cursor", () => {
    const text = 'what is in @"My File.md" please';
    const collapsedCursorAfterMention = "what is in ".length + 2;
    const expandedCursorAfterMention = 'what is in @"My File.md" '.length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterMention)).toBe(
      collapsedCursorAfterMention,
    );
  });

  it("maps expanded markdown file link cursors back to collapsed offsets", () => {
    const text = "what's in [AGENTS.md](AGENTS.md) please";
    const collapsedCursorAfterMention = "what's in ".length + 2;
    const expandedCursorAfterMention = "what's in [AGENTS.md](AGENTS.md) ".length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterMention)).toBe(
      collapsedCursorAfterMention,
    );
  });

  it("keeps package-like text expanded when another mention already exists earlier", () => {
    const text = "open @AGENTS.md then @src/index.ts ";
    const expandedCursor = text.length;
    const collapsedCursor = collapseExpandedComposerCursor(text, expandedCursor);

    expect(collapsedCursor).toBe("open ".length + 1 + " then @src/index.ts ".length);
  });

  it("collapses only genuine mentions when package-like text exists earlier", () => {
    const text = "install @scope/pkg then @README.md ";
    const expandedCursor = text.length;
    const collapsedCursor = collapseExpandedComposerCursor(text, expandedCursor);

    expect(collapsedCursor).toBe("install @scope/pkg then ".length + 1 + " ".length);
  });

  it.each(["$", "€", "𑿝"])("maps expanded %s skill cursor back to collapsed cursor", (prefix) => {
    const text = `run ${prefix}review-follow-up then`;
    const collapsedCursorAfterSkill = "run ".length + 2;
    const expandedCursorAfterSkill = `run ${prefix}review-follow-up `.length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterSkill)).toBe(
      collapsedCursorAfterSkill,
    );
  });
});

it("preserves the caret before trailing text after mixed-width skill chips", () => {
  const text = "𑿝ui a $review tail";
  const expanded = "𑿝ui a $review ".length;
  expect(collapseExpandedComposerCursor(text, expanded)).toBe(6);
});

describe("assistant citation cursor offsets", () => {
  it("maps source boundaries across citations, mentions, skills, and Unicode", () => {
    const prefix = "👋(";
    const between = "),雪";
    const after = " @AGENTS.md $review ";
    const text = `${prefix}${citationSource}${between}${citationSource}${after}${terminalReference}!`;
    const collapsedLength = `${prefix}□${between}□ □ □ □!`.length;
    const boundaries = [
      [prefix.length, prefix.length],
      [prefix.length + 1, prefix.length + citationSource.length],
      [prefix.length + 1 + between.length, prefix.length + citationSource.length + between.length],
      [
        prefix.length + 2 + between.length,
        prefix.length + citationSource.length * 2 + between.length,
      ],
      [collapsedLength, text.length],
    ] as const;

    for (const [collapsed, expanded] of boundaries) {
      expect(collapseExpandedComposerCursor(text, expanded)).toBe(collapsed);
    }
  });

  it("snaps serialized offsets inside a citation to the end of its chip", () => {
    const prefix = "前👋";
    const text = `${prefix}${citationSource}.`;

    for (const offset of [1, citationSource.length - 1, citationSource.length]) {
      expect(collapseExpandedComposerCursor(text, prefix.length + offset)).toBe(prefix.length + 1);
    }
  });

  it("deletes one citation without changing its neighbor or surrounding punctuation", () => {
    const text = `(${citationSource}),${citationSource}!`;
    const result = replaceTextRange(text, 1, 1 + citationSource.length, "");

    expect(result).toEqual({ text: `(),${citationSource}!`, cursor: 1 });
    expect(collapseExpandedComposerCursor(result.text, result.text.length)).toBe("(),□!".length);
  });
});

describe("replaceTextRange trailing space consumption", () => {
  it("double space after insertion when replacement ends with space", () => {
    // Simulates: "and then |@AG| summarize" where | marks replacement range
    // The replacement is "@AGENTS.md " (with trailing space)
    // But if we don't extend rangeEnd, the existing space stays
    const text = "and then @AG summarize";
    const rangeStart = "and then ".length;
    const rangeEnd = "and then @AG".length;

    // Without consuming trailing space: double space
    const withoutConsume = replaceTextRange(text, rangeStart, rangeEnd, "@AGENTS.md ");
    expect(withoutConsume.text).toBe("and then @AGENTS.md  summarize");

    // With consuming trailing space: single space
    const extendedEnd = text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
    const withConsume = replaceTextRange(text, rangeStart, extendedEnd, "@AGENTS.md ");
    expect(withConsume.text).toBe("and then @AGENTS.md summarize");
  });
});

describe("parseStandaloneComposerSlashCommand", () => {
  it("parses standalone /plan command", () => {
    expect(parseStandaloneComposerSlashCommand(" /plan ")).toBe("plan");
  });

  it("parses standalone /default command", () => {
    expect(parseStandaloneComposerSlashCommand("/default")).toBe("default");
  });

  it("ignores slash commands with extra message text", () => {
    expect(parseStandaloneComposerSlashCommand("/plan explain this")).toBeNull();
  });
});

describe("literal editor answer cursor state", () => {
  const prefill = "- [X] done $my-skill ";

  it("keeps character positions after token-like text for inserted lines and replacements", () => {
    for (const replacement of ["\n", "\t", "edited\n  "]) {
      const next = replaceTextRange(prefill, prefill.length, prefill.length, replacement);
      const cursor = collapseExpandedComposerCursor(next.text, next.cursor, true);
      expect(next.text).toBe(prefill + replacement);
      expect(cursor).toBe(next.text.length);
    }
    const replaced = replaceTextRange(prefill, 11, 20, "$another-skill");
    const cursor = collapseExpandedComposerCursor(replaced.text, replaced.cursor, true);
    expect(replaced.text).toBe("- [X] done $another-skill ");
    expect(cursor).toBe(25);
  });
});

describe("parseThreadAnnotationSlashCommand", () => {
  it("opens the editor for a bare command", () => {
    expect(parseThreadAnnotationSlashCommand(" /annotate ")).toEqual({ kind: "open-editor" });
  });

  it("captures inline and multiline markdown", () => {
    expect(parseThreadAnnotationSlashCommand("/annotate # Follow up\n- [ ] ship it")).toEqual({
      kind: "save",
      body: "# Follow up\n- [ ] ship it",
    });
  });

  it("is case insensitive but requires a command boundary", () => {
    expect(parseThreadAnnotationSlashCommand("/ANNOTATE #tag")).toEqual({
      kind: "save",
      body: "#tag",
    });
    expect(parseThreadAnnotationSlashCommand("/annotated nope")).toBeNull();
  });
});
