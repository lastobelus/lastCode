// Replace only hydration/config and remote RPC boundaries, retaining the production open/stores.
import { Atom, AsyncResult } from "effect/reactivity";
import { AuthPreviewOperateScope } from "@t3tools/contracts";
import { prepareHostedPreview as prepareOwnedPreview } from "@t3tools/client-runtime/preview-hosting";
import { isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import { ensureLocalApi } from "../../web/src/localApi.ts";

// The URL-only helper avoids loading unrelated file-asset hydration with openFileInPreview.
export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

export const fixtureState = {
  configuration: null,
  settings: null,
  preparationCount: 0,
  prepared: null,
  scopes: [],
};
export const primaryEnvironmentIdAtom = Atom.make("fixture-primary");
export const previewEnvironment = { open: "fixture-preview-open" };
export const randomUUID = () => crypto.randomUUID();

function owner(environmentId) {
  if (environmentId !== fixtureState.configuration.threadRef.environmentId)
    throw new Error(`Unexpected environment: ${environmentId}`);
}

export function readPreparedConnection(environmentId) {
  owner(environmentId);
  return { httpBaseUrl: fixtureState.configuration.environmentUrl };
}
export function readEnvironmentScope(environmentId, scope) {
  owner(environmentId);
  fixtureState.scopes.push({ environmentId, scope });
  if (scope !== AuthPreviewOperateScope) throw new Error(`Unexpected scope: ${scope}`);
  return true;
}
export function readEnvironmentSupportsServerBrowser(environmentId) {
  owner(environmentId);
  return true;
}
export const useEnvironmentSupportsServerBrowser = readEnvironmentSupportsServerBrowser;
export function readEnvironmentHasLocalDesktopBrowser(environmentId) {
  owner(environmentId);
  return false;
}

export function useAtomCommand(operation) {
  if (operation !== previewEnvironment.open) throw new Error(`Unexpected command: ${operation}`);
  return async (input) => AsyncResult.success(await window.openLinkFixtureBridge.open(input));
}

// Settings hydration is bounded, but its read uses the production LocalApi -> preload -> IPC.
let hydration;
export function ensureClientSettingsHydrated() {
  return (hydration ??= ensureLocalApi()
    .persistence.getClientSettings()
    .then((settings) => {
      if (!settings) throw new Error("Desktop settings IPC returned no fixture settings");
      fixtureState.settings = settings;
    }));
}
export function getClientSettings() {
  if (!fixtureState.settings) throw new Error("Settings were read before hydration");
  return fixtureState.settings;
}
export const useClientSettings = (select) => select(getClientSettings());

export function mayBeHostedPreviewUrl(threadRef, url) {
  owner(threadRef.environmentId);
  return isPrivateNetworkHost(new URL(url).hostname);
}
export async function prepareHostedPreview(threadRef, url, purpose = "navigation") {
  owner(threadRef.environmentId);
  fixtureState.preparationCount += 1;
  const prepared = await prepareOwnedPreview({
    threadRef,
    url,
    purpose,
    environmentUrl: fixtureState.configuration.environmentUrl,
    list: () => window.openLinkFixtureBridge.hosting("list", { threadRef, url }),
    recover: (lease, options) =>
      window.openLinkFixtureBridge.hosting("recover", { lease, options }),
  });
  fixtureState.prepared = prepared;
  return prepared;
}
