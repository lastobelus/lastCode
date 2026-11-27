import { ensureLocalApi } from "~/localApi";

/** Reserve a web tab during the click, before recovery can outlive user activation. */
export async function openPreparedExternalUrl(
  url: string,
  prepare: () => Promise<string | null>,
  // A managed link can finish in the integrated browser even if popups are blocked.
  options?: { readonly allowWithoutPopup?: boolean },
) {
  if (window.desktopBridge || !/^https?:\/\//i.test(url)) {
    const preparedUrl = await prepare();
    if (preparedUrl !== null) await ensureLocalApi().shell.openExternal(preparedUrl);
    return;
  }

  const tab = window.open("about:blank", "_blank");
  const popupBlocked = new Error("Unable to open link. Allow popups and try again.");
  if (!tab && !options?.allowWithoutPopup) throw popupBlocked;
  try {
    if (tab) {
      tab.opener = null;
      const referrer = tab.document.createElement("meta");
      referrer.name = "referrer";
      referrer.content = "no-referrer";
      tab.document.head.append(referrer);
    }
    const preparedUrl = await prepare();
    if (preparedUrl === null) {
      tab?.close();
      return;
    }
    if (!tab) throw popupBlocked;
    if (!tab.closed) tab.location.replace(preparedUrl);
  } catch (cause) {
    tab?.close();
    throw cause;
  }
}
