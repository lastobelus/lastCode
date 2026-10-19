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
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { projectLastCodeSidebarFamilies } from "../lastcodeSidebarFamilies.logic";
import { useLastCodeThreadIdentity } from "./useLastCodeThreadIdentity";
const mocks = vi.hoisted(() => ({
  primary: null as EnvironmentId | null,
  local: false,
  environmentRead: vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSetting: () => false,
  useClientSettings: () => ({}),
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: (id: EnvironmentId) => {
    mocks.environmentRead(id);
    return {
      label: "Member environment",
      entry: {
        target: {
          _tag: "BearerConnectionTarget",
          connectionId: mocks.local ? "local:backend" : "remote",
        },
      },
    };
  },
  usePrimaryEnvironmentId: () => mocks.primary,
}));
const thread = makeThreadFixture({
  environmentId: EnvironmentId.make("member"),
  modelSelection: { instanceId: ProviderInstanceId.make("same-provider"), model: "model" },
});
function provider(name: string): ServerProvider {
  return {
    instanceId: thread.modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    displayName: name,
    models: [{ slug: "model", name: `${name} model`, isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  };
}
const own = deriveProviderInstanceEntries([provider("Own")])[0]!;
const foreign = deriveProviderInstanceEntries([provider("Foreign")])[0]!;
const catalog = new Map([
  [thread.environmentId, new Map([[own.instanceId, own]])],
  [EnvironmentId.make("foreign"), new Map([[foreign.instanceId, foreign]])],
]);
function Harness({ badge = false, nested = false }: { badge?: boolean; nested?: boolean }) {
  const family = projectLastCodeSidebarFamilies({
    threads: [thread],
    collapsedByKey: {},
    activeThreadKey: null,
    projectExpanded: true,
    previewCount: 5,
    listExpanded: false,
    groupingStyle: "typed-groups",
    statusForThread: () => null,
  }).renderedRows[0]!;
  const value = useLastCodeThreadIdentity(
    nested ? { ...family, parentKey: "parent" } : family,
    catalog,
    undefined,
    { enabled: badge, size: 50, transparency: 0 },
  );
  return <output>{JSON.stringify(value)}</output>;
}
let root: Root, container: HTMLDivElement;
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
  vi.clearAllMocks();
  mocks.primary = null;
  mocks.local = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});
async function render(badge = false, nested = false) {
  await act(() => root.render(<Harness badge={badge} nested={nested} />));
  return JSON.parse(container.textContent!) as ReturnType<typeof useLastCodeThreadIdentity>;
}
describe("row provider and environment identity", () => {
  it("uses the owning member's provider catalog despite a same-ID foreign provider", async () => {
    const value = await render();
    expect(mocks.environmentRead).toHaveBeenCalledExactlyOnceWith(thread.environmentId);
    expect(value.providerEntry?.displayName).toBe("Own");
    expect(value.modelLabel).toContain("Own");
    expect(value.threadEnvironmentLabel).toBe("Member environment");
    expect(value.showsThreadEnvironmentIcon).toBe(true);
  });
  it("suppresses nested environment identity unless provider badges are enabled", async () => {
    const plain = await render(false, true);
    expect(plain.showsThreadEnvironmentIcon).toBe(false);
    expect(plain.threadEnvironmentLabel).toBeNull();
    const badged = await render(true, true);
    expect(badged.showsThreadEnvironmentIcon).toBe(true);
    expect(badged.threadEnvironmentLabel).toBe("Member environment");
  });
  it("keeps desktop-local secondary threads local without the remote glyph", async () => {
    mocks.local = true;
    const value = await render();
    expect(value.showsThreadEnvironmentIcon).toBe(false);
    expect(value.threadEnvironmentLabel).toBe("Member environment");
  });
  it("keeps a primary local thread icon hidden without the local-icon setting", async () => {
    mocks.primary = thread.environmentId;
    const value = await render();
    expect(value.showsThreadEnvironmentIcon).toBe(false);
    expect(value.threadEnvironmentLabel).toBeNull();
  });
});
