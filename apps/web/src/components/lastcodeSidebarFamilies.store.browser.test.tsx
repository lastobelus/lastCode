import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  useCollapsedLastCodeSidebarFamilies,
  useLastCodeSidebarFamiliesStore,
} from "./lastcodeSidebarFamilies.store";
import { lastcodeSidebarSubagentGroupKey } from "./lastcodeSidebarFamilies.logic";

let root: Root;

const key = (environment: string, thread: string) =>
  scopedThreadKey(scopeThreadRef(EnvironmentId.make(environment), ThreadId.make(thread)));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  useLastCodeSidebarFamiliesStore.setState({ collapsedByKey: {} });
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("only updates a project subscription for its scoped threads, including grouped environments", async () => {
  const firstKey = key("environment-one", "parent");
  const groupedKey = key("environment-two", "parent");
  const subagentGroupKey = lastcodeSidebarSubagentGroupKey(firstKey);
  const observed: Record<string, boolean>[] = [];
  function Probe({ threadKeys }: { threadKeys: string[] }) {
    observed.push(useCollapsedLastCodeSidebarFamilies(threadKeys));
    return null;
  }
  const threadKeys = [firstKey, groupedKey, subagentGroupKey];
  await act(() => {
    root.render(<Probe threadKeys={threadKeys} />);
  });
  const initial = observed.at(-1);
  const initialRenderCount = observed.length;
  const { setCollapsed } = useLastCodeSidebarFamiliesStore.getState();

  await act(() => {
    setCollapsed(key("environment-one", "other-project-parent"), true);
    setCollapsed(key("environment-three", "parent"), true);
  });
  expect(observed).toHaveLength(initialRenderCount);
  await act(() => root.render(<Probe threadKeys={[...threadKeys]} />));
  expect(observed.at(-1)).toBe(initial);

  await act(() => setCollapsed(firstKey, true));
  expect(observed.at(-1)).toEqual({ [firstKey]: true });
  await act(() => setCollapsed(groupedKey, true));
  expect(observed.at(-1)).toEqual({ [firstKey]: true, [groupedKey]: true });
  await act(() => setCollapsed(firstKey, false));
  expect(observed.at(-1)).toEqual({ [firstKey]: false, [groupedKey]: true });
  await act(() => setCollapsed(subagentGroupKey, false));
  expect(observed.at(-1)).toEqual({
    [firstKey]: false,
    [groupedKey]: true,
    [subagentGroupKey]: false,
  });

  await act(() => root.render(<Probe threadKeys={[firstKey]} />));
  expect(observed.at(-1)).toEqual({ [firstKey]: false });
});
