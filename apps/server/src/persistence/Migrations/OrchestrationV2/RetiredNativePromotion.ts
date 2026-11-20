import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Retired jobs must neither execute nor enter the current effect decoder.
  // Keep thread projections and the append-only event history untouched.
  yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE effect_type = 'subagent.promote'`;
});
