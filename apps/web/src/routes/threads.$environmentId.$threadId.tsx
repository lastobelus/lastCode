import { resolveThreadRouteRef, safeThreadRouteParams } from "../threadRoutes";
import { Navigate, createFileRoute, useRouter } from "@tanstack/react-router";

// A copied thread link. On the hosted app its chooser shows first; this opens the thread after it.
export const Route = createFileRoute("/threads/$environmentId/$threadId")({
  component: function ThreadLinkRedirect() {
    const params = Route.useParams();
    const router = useRouter();
    const ref = resolveThreadRouteRef(params);
    const target = ref && safeThreadRouteParams(router, ref);
    return target ? (
      <Navigate to="/$environmentId/$threadId" params={target} search replace />
    ) : null;
  },
});
