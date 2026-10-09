import { ensureLocalApi } from "~/localApi";

/** Reserve a web tab during the click, before recovery can outlive user activation. */
export async function openPreparedExternalUrl(url: string, prepare: () => Promise<string>) {
  if (window.desktopBridge || !/^https?:\/\//i.test(url)) {
    await ensureLocalApi().shell.openExternal(await prepare());
    return;
  }

  const tab = window.open("about:blank", "_blank");
  if (!tab) throw new Error("Unable to open link. Allow popups and try again.");
  try {
    tab.opener = null;
    const referrer = tab.document.createElement("meta");
    referrer.name = "referrer";
    referrer.content = "no-referrer";
    tab.document.head.append(referrer);
    const preparedUrl = await prepare();
    if (!tab.closed) tab.location.replace(preparedUrl);
  } catch (cause) {
    tab.close();
    throw cause;
  }
}
