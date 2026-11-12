import { lazy, Suspense } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const T3ConnectAccount = lazy(() => import("../clerk/T3ConnectAccount"));

export function ConnectAccountSettings() {
  return (
    <SettingsPageContainer>
      <SettingsSection title="T3 Connect" id="connect-account">
        <div className="space-y-4 px-3 text-sm sm:px-4">
          <p className="text-muted-foreground">
            Manage your T3 Connect account here. Signing in does not turn on a tunnel or make any
            host reachable. To let other devices reach a host, turn on T3 Connect in Sharing &amp;
            access settings on that host.
          </p>
          {hasCloudPublicConfig() ? (
            <Suspense fallback={<p role="status">Loading account…</p>}>
              <T3ConnectAccount />
            </Suspense>
          ) : (
            <p role="status" className="text-muted-foreground">
              T3 Connect sign-in is unavailable at this address or in this build. To sign in, use
              the desktop app or the hosted T3 Code app.
            </p>
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
