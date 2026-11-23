import { T, useGT } from "gt-react";
import { lazy, Suspense } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const T3ConnectAccount = lazy(() => import("../clerk/T3ConnectAccount"));

export function ConnectAccountSettings() {
  const gt = useGT();
  return (
    <SettingsPageContainer>
      <SettingsSection title="T3 Connect" id="connect-account">
        <div className="space-y-4 px-3 text-sm sm:px-4">
          <p className="text-muted-foreground">
            {gt(
              "Manage your {t3Connect} account here. Signing in does not turn on a tunnel or make any host reachable. To let other devices reach a host, turn on {t3Connect} in Sharing & access settings on that host.",
              { t3Connect: "T3 Connect" },
            )}
          </p>
          {hasCloudPublicConfig() ? (
            <Suspense
              fallback={
                <p role="status">
                  <T>Loading account…</T>
                </p>
              }
            >
              <T3ConnectAccount />
            </Suspense>
          ) : (
            <p role="status" className="text-muted-foreground">
              {gt(
                "{t3Connect} sign-in is unavailable at this address or in this build. To sign in, use the desktop app or the hosted {t3Code} app.",
                { t3Connect: "T3 Connect", t3Code: "T3 Code" },
              )}
            </p>
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
