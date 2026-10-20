import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import { LASTCODE_DESKTOP_DISTRIBUTION } from "@t3tools/shared/desktopDistribution";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

/** Origins of the Electron renderer, packaged and dev. */
export const DESKTOP_RENDERER_ORIGINS = [
  "t3code://app",
  "t3code-dev://app",
  `${LASTCODE_DESKTOP_DISTRIBUTION.productionScheme}://app`,
  `${LASTCODE_DESKTOP_DISTRIBUTION.developmentScheme}://app`,
] as const;
