function mergeClientSettings(sourceRaw: string, destinationRaw: string | null): string {
  const source = decodeSourceClientSettings(sourceRaw);
  const destination =
    destinationRaw === null
      ? decodeClientSettingsJson("{}")
      : decodeSourceClientSettings(destinationRaw);
  const isBuiltInProviderPreference = (provider: string) =>
    BUILT_IN_PROVIDER_INSTANCE_IDS.has(provider);
  const favorites = [
    ...destination.favorites.filter(({ provider }) => !isBuiltInProviderPreference(provider)),
    ...source.favorites.filter(({ provider }) => isBuiltInProviderPreference(provider)),
  ];
  const providerModelPreferences = Object.fromEntries([
    ...Object.entries(destination.providerModelPreferences).filter(
      ([provider]) => !isBuiltInProviderPreference(provider),
    ),
    ...Object.entries(source.providerModelPreferences).filter(([provider]) =>
      isBuiltInProviderPreference(provider),
    ),
  ]);
  return `${encodeClientSettingsJson({
    ...source,
    favorites,
    providerModelPreferences,
    compactLegacySidebarStatuses: destination.compactLegacySidebarStatuses,
    environmentIconColors: destination.environmentIconColors,
    legacySidebarScale: destination.legacySidebarScale,
    roundedProjectIcons: destination.roundedProjectIcons,
    showLocalEnvironmentIcon: destination.showLocalEnvironmentIcon,
    showThreadProviderBadge: destination.showThreadProviderBadge,
    threadProviderBadgeSize: destination.threadProviderBadgeSize,
    threadProviderBadgeTransparency: destination.threadProviderBadgeTransparency,
    showThreadWorktreeIndicators: destination.showThreadWorktreeIndicators,
  })}\n`;
}

