import { createFileRoute } from "@tanstack/react-router";
import { ConnectAccountSettings } from "../components/settings/ConnectAccountSettings";

export const Route = createFileRoute("/_chat/settings/connect")({
  component: ConnectAccountSettings,
});
