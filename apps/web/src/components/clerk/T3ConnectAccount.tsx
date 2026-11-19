import {
  ClerkDegraded,
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  useClerk,
  useUser,
} from "@clerk/react";
import { msg, T, useGT } from "gt-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import { Button } from "../ui/button";
import { useT3ConnectAccountPage } from "./T3ConnectAccountPages";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

function AccountRecovery({ children }: { children: string }) {
  return (
    <div role="alert" className="space-y-3">
      <p>{children}</p>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        <T>Reload page</T>
      </Button>
    </div>
  );
}

function AccountLoading() {
  return (
    <>
      <p role="status">
        <T>Loading account…</T>
      </p>
      <p className="text-muted-foreground">
        <T>If loading does not finish, check your connection and reload the page.</T>
      </p>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        <T>Reload page</T>
      </Button>
    </>
  );
}

function LoadedAccount() {
  const gt = useGT();
  const { isLoaded, isSignedIn, user } = useUser();
  const clerk = useClerk();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const accountPage = useT3ConnectAccountPage();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (action: () => unknown) => {
    setError(null);
    setPending(true);
    try {
      await action();
    } catch {
      setError(m(msg("Could not complete the account action. Try again or reload the page.")));
    }
    setPending(false);
  };

  if (!isLoaded) return <AccountLoading />;

  return (
    <div className="space-y-4">
      {isSignedIn ? (
        <>
          <p>
            {gt("Signed in as {account}.", {
              account:
                user.primaryEmailAddress?.emailAddress ??
                user.fullName ??
                gt("{t3Connect} user", { t3Connect: "T3 Connect" }),
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pending || !accountPage.open}
              onClick={() => void runAction(() => accountPage.open?.())}
            >
              <T>Manage account</T>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void runAction(() => clerk.signOut())}
            >
              <T>Sign out</T>
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>{gt("You are not signed in to {t3Connect}.", { t3Connect: "T3 Connect" })}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void runAction(openAuthPrompt)}
          >
            {gt("Sign in to {t3Connect}", { t3Connect: "T3 Connect" })}
          </Button>
        </>
      )}
      {error ? <AccountRecovery>{error}</AccountRecovery> : null}
      {accountPage.portals}
    </div>
  );
}

export default function T3ConnectAccount() {
  const gt = useGT();
  return (
    <>
      <ClerkLoading>
        <AccountLoading />
      </ClerkLoading>
      <ClerkFailed>
        <AccountRecovery>
          {gt(
            "{t3Connect} sign-in could not load. Check your connection and browser privacy settings, then reload the page.",
            { t3Connect: "T3 Connect" },
          )}
        </AccountRecovery>
      </ClerkFailed>
      <ClerkDegraded>
        <AccountRecovery>
          {gt(
            "{t3Connect} sign-in is partly unavailable right now. Some account actions may not work. Reload the page to try again.",
            { t3Connect: "T3 Connect" },
          )}
        </AccountRecovery>
      </ClerkDegraded>
      <ClerkLoaded>
        <LoadedAccount />
      </ClerkLoaded>
    </>
  );
}
