import type { previewBridge } from "~/components/preview/previewBridge";

type PreviewBridge = NonNullable<typeof previewBridge>;

function unexpectedCall(path: string): object {
  return new Proxy(
    () => {
      throw new Error(
        `Unexpected preview bridge call: ${path}; provide an explicit test implementation.`,
      );
    },
    {
      get: (_target, property) =>
        typeof property === "string" && property !== "then"
          ? unexpectedCall(`${path}.${property}`)
          : undefined,
    },
  );
}

export function createPreviewBridgeFixture(overrides: Partial<PreviewBridge>): PreviewBridge {
  const implementations = {
    onBrowserRendererRequest: () => () => undefined,
    onTunnelAccessRequest: () => () => undefined,
    ...overrides,
  } satisfies Partial<PreviewBridge>;
  // Only implemented members need maintaining. A bridge addition can stay unused;
  // invoking it fails by name, including methods inside recording/pictureInPicture.
  return new Proxy(implementations, {
    get: (target, property, receiver) => {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      if (typeof property !== "string" || property === "then") return undefined;
      return unexpectedCall(`preview.${property}`);
    },
  }) as PreviewBridge;
}
