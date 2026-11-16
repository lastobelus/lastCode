import {
  ClerkDegraded,
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  useClerk,
  useUser,
} from "@clerk/react";
import { useState } from "react";

import { Button } from "../ui/button";
import { useT3ConnectAccountPage } from "./T3ConnectAccountPages";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

function AccountRecovery({ children }: { children: string }) {
  return (
    <div role="alert" className="space-y-3">
      <p>{children}</p>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        Reload page
      </Button>
    </div>
  );
}

function AccountLoading() {
  return (
    <>
      <p role="status">Loading account…</p>
      <p className="text-muted-foreground">
        If loading does not finish, check your connection and reload the page.
      </p>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        Reload page
      </Button>
    </>
  );
}

function LoadedAccount() {
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
      setError("Could not complete the account action. Try again or reload the page.");
    }
    setPending(false);
  };

  if (!isLoaded) return <AccountLoading />;

  return (
    <div className="space-y-4">
      {isSignedIn ? (
        <>
          <p>
            Signed in as{" "}
            {user.primaryEmailAddress?.emailAddress ?? user.fullName ?? "T3 Connect user"}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pending || !accountPage.open}
              onClick={() => void runAction(() => accountPage.open?.())}
            >
              Manage account
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void runAction(() => clerk.signOut())}
            >
              Sign out
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>You are not signed in to T3 Connect.</p>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void runAction(openAuthPrompt)}
          >
            Sign in to T3 Connect
          </Button>
        </>
      )}
      {error ? <AccountRecovery>{error}</AccountRecovery> : null}
      {accountPage.portals}
    </div>
  );
}

export default function T3ConnectAccount() {
  return (
    <>
      <ClerkLoading>
        <AccountLoading />
      </ClerkLoading>
      <ClerkFailed>
        <AccountRecovery>
          T3 Connect sign-in could not load. Check your connection and browser privacy settings,
          then reload the page.
        </AccountRecovery>
      </ClerkFailed>
      <ClerkDegraded>
        <AccountRecovery>
          T3 Connect sign-in is partly unavailable right now. Some account actions may not work.
          Reload the page to try again.
        </AccountRecovery>
      </ClerkDegraded>
      <ClerkLoaded>
        <LoadedAccount />
      </ClerkLoaded>
    </>
  );
}
