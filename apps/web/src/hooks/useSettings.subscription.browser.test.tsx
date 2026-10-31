import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
const persistence = vi.hoisted(() => ({
  getClientSettings: vi.fn(async () => null),
  setClientSettings: vi.fn(async () => {}),
}));
vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ persistence }) }));
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  useClientSetting,
  updateClientSettings,
} from "./useSettings";
let root: Root;
let container: HTMLDivElement;
const compactRender = vi.fn();
const groupingRender = vi.fn();
const counts = () => ({
  compact: compactRender.mock.calls.length,
  grouping: groupingRender.mock.calls.length,
});
function Compact() {
  compactRender();
  const value = useClientSetting("compactLegacySidebarStatuses");
  return <output data-testid="compact">{String(value)}</output>;
}
function Grouping() {
  groupingRender();
  const value = useClientSetting("legacySidebarThreadGroupingStyle");
  return <output data-testid="grouping">{value}</output>;
}
const original = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
beforeAll(() =>
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  }),
);
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", original);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
beforeEach(() => {
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  __resetClientSettingsPersistenceForTests();
});
async function mount() {
  await act(() =>
    root.render(
      <>
        <Compact />
        <Grouping />
      </>,
    ),
  );
}
describe("key-specific client settings subscriptions", () => {
  it("does not render for unrelated settings or write while subscribing", async () => {
    await mount();
    expect(persistence.setClientSettings).not.toHaveBeenCalled();
    const before = counts();
    await act(async () => {
      await updateClientSettings({ timestampFormat: "12-hour" });
    });
    expect(counts()).toEqual(before);
  });
  it("updates only the compact consumer when compact status changes", async () => {
    await mount();
    const before = counts();
    await act(async () => {
      await updateClientSettings({
        compactLegacySidebarStatuses: !DEFAULT_CLIENT_SETTINGS.compactLegacySidebarStatuses,
      });
    });
    expect(counts()).toEqual({ compact: before.compact + 1, grouping: before.grouping });
    expect(container.querySelector('[data-testid="compact"]')?.textContent).toBe(
      String(!DEFAULT_CLIENT_SETTINGS.compactLegacySidebarStatuses),
    );
  });
  it("updates grouping independently and ignores a repeated identical value", async () => {
    await mount();
    const before = counts();
    const value =
      DEFAULT_CLIENT_SETTINGS.legacySidebarThreadGroupingStyle === "minimal"
        ? "typed-groups"
        : "minimal";
    await act(async () => {
      await updateClientSettings({ legacySidebarThreadGroupingStyle: value });
    });
    expect(counts()).toEqual({ compact: before.compact, grouping: before.grouping + 1 });
    expect(container.querySelector('[data-testid="grouping"]')?.textContent).toBe(value);
    const changed = counts();
    await act(async () => {
      await updateClientSettings({ legacySidebarThreadGroupingStyle: value });
    });
    expect(counts()).toEqual(changed);
  });
});
