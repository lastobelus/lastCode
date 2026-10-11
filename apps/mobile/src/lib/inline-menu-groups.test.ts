import { describe, expect, it } from "vite-plus/test";
import { flattenInlineMenuGroups } from "./inline-menu-groups";

describe("Android inline menu groups", () => {
  it("keeps commands at the same level with dividers between groups", () => {
    const rows = flattenInlineMenuGroups([
      { title: "", displayInline: true, subactions: [{ id: "new", title: "New thread" }] },
      {
        title: "",
        displayInline: true,
        subactions: [
          { id: "persistent", title: "Mark persistent" },
          { id: "stop", title: "Stop processes" },
        ],
      },
      { id: "archive", title: "Archive" },
    ]);
    expect(rows.map(({ action, separatorBefore }) => [action.id, separatorBefore])).toEqual([
      ["new", false],
      ["persistent", true],
      ["stop", false],
      ["archive", true],
    ]);
  });

  it("preserves real submenus and skips empty or hidden groups", () => {
    const submenu = { id: "copy", title: "Copy", subactions: [{ id: "id", title: "Thread ID" }] };
    expect(
      flattenInlineMenuGroups([
        { title: "", displayInline: true, subactions: [] },
        {
          title: "",
          displayInline: true,
          subactions: [{ title: "Hidden", attributes: { hidden: true } }],
        },
        submenu,
      ]),
    ).toEqual([{ action: submenu, separatorBefore: false }]);
  });
});
