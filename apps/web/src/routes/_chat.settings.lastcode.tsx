import { createFileRoute } from "@tanstack/react-router";

import { LastCodeSettingsPanel } from "../components/settings/LastCodeSettings";

export const Route = createFileRoute("/_chat/settings/lastcode")({
  component: LastCodeSettingsPanel,
});
