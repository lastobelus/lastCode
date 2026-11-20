import type * as SqlClient from "effect/sql/SqlClient";

// SQL counterpart of isOwnedSubagentThread and its local lineage parent.
export const ownedSubagentParentSql = (sql: SqlClient.SqlClient, alias: string) => {
  const payload = sql.literal(`${alias}.payload_json`);
  return sql`CASE WHEN json_extract(${payload}, '$.lineage.relationshipToParent') = 'subagent'
    AND json_extract(${payload}, '$.lineage.independent') IS NOT 1
    THEN json_extract(${payload}, '$.lineage.parentThreadId') END`;
};
