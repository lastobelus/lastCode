import { describe, expect, it } from "vite-plus/test";
import { classifyLastCodeSecondaryConnections } from "./lastcodeSidebarConnections.logic";

const bootstrap = (label: string, httpBaseUrl: string | null) => ({
  id: label,
  label,
  httpBaseUrl,
  wsBaseUrl: null,
});
describe("LastCode secondary connection notice", () => {
  it("keeps cold/missing/connecting backends visible and clears only connected URLs", () => {
    const result = classifyLastCodeSecondaryConnections(
      [
        bootstrap("Cold", null),
        bootstrap("Missing", "http://missing.example"),
        bootstrap("Starting", "http://starting.example"),
        bootstrap("Ready", "http://ready.example"),
        bootstrap("Failed", "http://failed.example"),
      ],
      new Map([
        ["http://starting.example", { phase: "connecting", error: null }],
        ["http://ready.example", { phase: "connected", error: null }],
        ["http://failed.example", { phase: "error", error: "Connection refused" }],
      ]),
    );
    expect(result).toEqual({
      connecting: ["Cold", "Missing", "Starting"],
      failed: [{ label: "Failed", error: "Connection refused" }],
    });
  });
  it("retains null errors for the existing render fallback and never matches a null URL", () => {
    expect(
      classifyLastCodeSecondaryConnections(
        [bootstrap("Cold", null), bootstrap("Failed", "http://failed.example")],
        new Map([["http://failed.example", { phase: "error", error: null }]]),
      ),
    ).toEqual({ connecting: ["Cold"], failed: [{ label: "Failed", error: null }] });
    expect(classifyLastCodeSecondaryConnections([], new Map())).toEqual({
      connecting: [],
      failed: [],
    });
  });
});
