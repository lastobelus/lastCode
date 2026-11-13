import type { previewBridge } from "~/components/preview/previewBridge";

type PreviewBridge = NonNullable<typeof previewBridge>;

export function createPreviewBridgeFixture(overrides: Partial<PreviewBridge>): PreviewBridge {
  const unexpected = (): never => {
    throw new Error("Unexpected preview bridge call; provide an explicit test implementation.");
  };
  // Keep this exhaustive so bridge additions fail typechecking instead of a late browser run.
  return {
    bindBrowserEnvironment: unexpected,
    onBrowserSurfaceRequest: unexpected,
    onBrowserRendererRequest: () => () => undefined,
    browserSurfaceResponse: unexpected,
    browserPresentation: unexpected,
    browserCommand: unexpected,
    onBrowserEvent: unexpected,
    setForwardedShortcuts: unexpected,
    createTab: unexpected,
    closeTab: unexpected,
    registerWebview: unexpected,
    navigate: unexpected,
    goBack: unexpected,
    goForward: unexpected,
    refresh: unexpected,
    zoomIn: unexpected,
    zoomOut: unexpected,
    resetZoom: unexpected,
    setZoomFactor: unexpected,
    hardReload: unexpected,
    findInPage: unexpected,
    stopFindInPage: unexpected,
    onFindResult: unexpected,
    setColorScheme: unexpected,
    setAudioMuted: unexpected,
    setShown: unexpected,
    openDevTools: unexpected,
    clearCookies: unexpected,
    clearCache: unexpected,
    getPreviewConfig: unexpected,
    listBrowserImportSources: unexpected,
    importBrowserCookies: unexpected,
    annotationVoice: { onEvent: unexpected, update: unexpected },
    setAnnotationTheme: unexpected,
    setAnnotationSendEnabled: unexpected,
    pickElement: unexpected,
    cancelPickElement: unexpected,
    captureScreenshot: unexpected,
    revealArtifact: unexpected,
    copyArtifactToClipboard: unexpected,
    pictureInPicture: { open: unexpected, close: unexpected },
    recording: {
      onInput: unexpected,
      startScreencast: unexpected,
      stopScreencast: unexpected,
      save: unexpected,
    },
    onStateChange: unexpected,
    onPointerEvent: unexpected,
    onOpenLink: unexpected,
    ...overrides,
  };
}
