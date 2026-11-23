import type { RepositoryIdentity } from "@t3tools/contracts";
import { selectLastCodeIssueRepository } from "@t3tools/source-control-core/shared/definition";
import * as Effect from "effect/Effect";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

export const make = (options: RepositoryIdentityResolver.RepositoryIdentityResolverOptions) => {
  const refine = options.refine ?? Effect.succeed;
  return RepositoryIdentityResolver.make({
    ...options,
    refine: Effect.fnUntraced(function* (identity: RepositoryIdentity) {
      if (identity.origin?.remoteUrl === undefined) return yield* refine(identity);
      const origin = selectLastCodeIssueRepository(identity, sourceControlDefinitions);
      if (origin === null) return yield* refine(identity);

      // Probe the origin's own remote. The canonical remote's login can name a different forge.
      const [canonical, refinedOrigin] = yield* Effect.all(
        [
          refine(identity).pipe(Effect.orElseSucceed(() => identity)),
          refine(origin).pipe(Effect.orElseSucceed(() => origin)),
        ],
        { concurrency: 2 },
      );
      const { provider, webUrl } = refinedOrigin;
      return {
        ...canonical,
        origin: {
          ...identity.origin,
          ...(provider === undefined ? {} : { provider }),
          ...(webUrl === undefined ? {} : { webUrl }),
        },
      };
    }),
  });
};
