import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useOpenLink } from "../../web/src/browser/useOpenLink.ts";
import { isElectron } from "../../web/src/env.ts";
import { useBrowserHistoryStore } from "../../web/src/browserHistoryStore.ts";
import { readThreadPreviewState } from "../../web/src/previewStateStore.ts";
import {
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from "../../web/src/rightPanelStore.ts";
import { fixtureState } from "./browser-open-link.state.fixture.mjs";

function check(value, message) {
  if (!value) throw new Error(message);
}

async function main() {
  check(
    window.desktopBridge?.preview,
    "Production desktopBridge is absent; web-branch proof refused",
  );
  check(isElectron, "Production env module must detect the native desktop renderer");
  check(Object.isFrozen(window.desktopBridge), "desktopBridge must be exposed by contextBridge");
  const configuration = await window.openLinkFixtureBridge.configuration();
  fixtureState.configuration = configuration;
  const { threadRef, sourceUrl, projectKey } = configuration;
  useBrowserHistoryStore.getState().registerThreadProject(threadRef, projectKey);
  useRightPanelStore.getState().open(threadRef, "files");
  const initialRevision = useRightPanelStore.getState().getUserActionRevision(threadRef);
  const diagnostics = () => {
    const preview = readThreadPreviewState(threadRef);
    return {
      desktopBridgePresent: Boolean(window.desktopBridge?.preview),
      isElectron,
      preference: fixtureState.settings?.browserLinkTarget,
      preparationCount: fixtureState.preparationCount,
      prepared: fixtureState.prepared,
      scopes: fixtureState.scopes,
      revision: useRightPanelStore.getState().getUserActionRevision(threadRef),
      surface: selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
      activeTabId: preview.activeTabId,
      sessions: preview.sessions,
      recentlySeenUrls: preview.recentlySeenUrls,
      history: useBrowserHistoryStore.getState().byProjectKey[projectKey] ?? [],
    };
  };
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  function Fixture() {
    const openLink = useOpenLink(threadRef);
    useEffect(() => {
      void window.openLinkFixtureBridge.report({
        type: "ready",
        initialRevision,
        ...diagnostics(),
      });
    }, []);
    return createElement(
      "a",
      {
        id: "managed-link",
        href: sourceUrl,
        style: { display: "block", padding: "30px", fontSize: "20px" },
        onClick: (event) => {
          event.preventDefault();
          const input = {
            trusted: event.nativeEvent.isTrusted,
            desktopBridgeAtClick: Boolean(window.desktopBridge?.preview),
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            button: event.button,
          };
          void (async () => {
            check(input.trusted, "The hook must be driven by native renderer input");
            check(input.desktopBridgeAtClick, "desktopBridge disappeared before the real click");
            await openLink(sourceUrl, { event: input });
            await window.openLinkFixtureBridge.report({
              type: "clicked",
              input,
              ...diagnostics(),
            });
          })().catch((cause) =>
            window.openLinkFixtureBridge.report({
              type: "failure",
              error: cause?.stack ?? String(cause),
              ...diagnostics(),
            }),
          );
        },
      },
      sourceUrl,
    );
  }
  window.openLinkFixture = {
    diagnostics,
    dispose: () => root.unmount(),
  };
  root.render(createElement(Fixture));
}

void main().catch((cause) =>
  window.openLinkFixtureBridge.report({
    type: "failure",
    error: cause?.stack ?? String(cause),
  }),
);
