import type { Locator } from "playwright-core";

const MAX_CANDIDATES = 4;
const MAX_NAME_LENGTH = 60;
// The MCP broker clips longer execution errors.
const MAX_DIAGNOSTIC_LENGTH = 500;
const ARIA_CONTROLS = [
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "radio",
  "switch",
  "tab",
  "textbox",
];
const NATIVE_CONTROLS = ["button", "input", "select", "textarea"];

export const strictClickMatchCount = (cause: unknown) => {
  if (!(cause instanceof Error)) return undefined;
  const firstLine = cause.message.split("\n", 1)[0] ?? "";
  const count =
    /^locator\.(?:scrollIntoViewIfNeeded|boundingBox|click): (?:Error: )?strict mode violation: .* resolved to (\d+) elements:$/.exec(
      firstLine,
    )?.[1];
  return count === undefined ? undefined : Number(count);
};

// The server's TypeScript project excludes the DOM library. This function runs in Chromium.
type BrowserLabelElement = {
  readonly localName: string;
  readonly innerText?: string;
  readonly textContent: string | null;
  readonly parentElement: BrowserLabelElement | null;
  readonly labels?: ArrayLike<BrowserLabelElement>;
  checkVisibility(options: { visibilityProperty: boolean }): boolean;
  closest(selector: string): BrowserLabelElement | null;
  getAttribute(name: string): string | null;
  getRootNode(): { getElementById(id: string): BrowserLabelElement | null };
  matches(selector: string): boolean;
  querySelector(selector: string): BrowserLabelElement | null;
};

type MatchingControl = {
  readonly kind: string | undefined;
  readonly name: string;
  readonly context: string;
};

// Even a locator-scoped ariaSnapshot replaces Playwright's native ref lookup.
export const readMatchingControls = (locator: Locator, count: number) =>
  locator.evaluateAll(
    (matches: BrowserLabelElement[], { count, limit, ariaControls, nativeControls }) => {
      if (matches.length !== count) return [];
      const renderedText = (element: BrowserLabelElement | null | undefined) =>
        element?.checkVisibility({ visibilityProperty: true }) ? (element.innerText ?? "") : "";
      const nameOf = (element: BrowserLabelElement, fallback = "") => {
        const root = element.getRootNode();
        const referenced = (element.getAttribute("aria-labelledby") ?? "")
          .trim()
          .split(/\s+/)
          .map((id) => (id ? root.getElementById(id)?.textContent : ""))
          .join(" ")
          .trim();
        const name = referenced || element.getAttribute("aria-label") || fallback;
        // Drop oversized names whole so a field value crossing the cap can still be masked.
        return name.length <= 900
          ? name
              .replace(/[\u200b\u00ad]/g, "")
              .trim()
              .replace(/\s+/g, " ")
          : "";
      };
      return matches.slice(0, limit).map((element) => {
        const explicitRole = element.getAttribute("role");
        const role = ariaControls.find((role) => role === explicitRole);
        const kind =
          role ??
          nativeControls.find((tag) => tag === element.localName) ??
          (element.matches("a[href]") ? "link" : undefined);
        const ancestor = element.parentElement?.closest(
          "tr, li, fieldset, [role=row], [role=listitem], [role=group]",
        );
        const rowHeader = ancestor?.querySelector(
          ":scope > [role=rowheader], :scope > th[scope=row], :scope > legend",
        );
        const context = ancestor ? nameOf(ancestor, renderedText(rowHeader)) : "";
        const fallback = element.matches("input, select, textarea")
          ? Array.from(element.labels ?? [], renderedText).join(" ")
          : renderedText(element);
        return {
          kind,
          name: kind ? nameOf(element, fallback) : "",
          context,
        };
      });
    },
    { count, limit: MAX_CANDIDATES, ariaControls: ARIA_CONTROLS, nativeControls: NATIVE_CONTROLS },
  );

export const describeClickAmbiguity = (
  count: number,
  controls: readonly MatchingControl[],
  mask: (name: string) => string,
) => {
  const label = (name: string) => {
    // Keep encoded payloads and formatting controls out even when used as a name.
    const safe = /data:/i.test(name)
      ? ""
      : mask(name)
          .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
          .trim();
    const clipped = safe.length > MAX_NAME_LENGTH ? safe.slice(0, MAX_NAME_LENGTH) + "…" : safe;
    return clipped ? JSON.stringify(clipped) : "";
  };
  const descriptions = controls.slice(0, MAX_CANDIDATES).map(({ kind, name, context }) => {
    if (!kind || ![...ARIA_CONTROLS, ...NATIVE_CONTROLS].includes(kind)) return "";
    const control = label(name);
    const container = label(context);
    return [kind, control, container && `in ${container}`].filter(Boolean).join(" ");
  });
  const message =
    `Click refused: the locator matched ${count} elements.\n` +
    "Take a fresh snapshot with preview_snapshot. Use its ref or scope the locator to the intended container.";
  if (!descriptions.every(Boolean) || new Set(descriptions).size !== descriptions.length)
    return message;
  const heading = "\nCurrent matches include:";
  let remaining = MAX_DIAGNOSTIC_LENGTH - message.length - heading.length;
  const lines: string[] = [];
  for (const description of descriptions) {
    const line = `\n- ${description}`;
    if (line.length > remaining) break;
    lines.push(line);
    remaining -= line.length;
  }
  return lines.length > 1 ? message + heading + lines.join("") : message;
};
