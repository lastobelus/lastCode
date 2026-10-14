import { useLocalEnvironment } from "../../state/environments";
import { EnvironmentPauseControl as EnvironmentPauseButton } from "../EnvironmentPauseControl";

/** Going offline from the sidebar affects only the machine running this client. */
export function EnvironmentPauseControl({ onBackdrop }: { onBackdrop: boolean }) {
  const environment = useLocalEnvironment();
  return environment ? (
    <EnvironmentPauseButton
      key={environment.environmentId}
      environment={environment}
      onBackdrop={onBackdrop}
      size="titlebar-icon"
    />
  ) : null;
}
