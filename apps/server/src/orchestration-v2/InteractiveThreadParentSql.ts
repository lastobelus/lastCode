import type * as SqlClient from "effect/sql/SqlClient";

// SQL counterpart of getInteractiveThreadParentThreadId. Field absence differs
// from an explicit JSON null, which records a durable detach.
// TEXT affinity lets recursive thread-ID joins seek the matching expression index.
export const interactiveThreadParentSql = (sql: SqlClient.SqlClient, alias: string) => {
  const payload = sql.literal(`${alias}.payload_json`);
  return sql`CAST(CASE
    WHEN json_extract(${payload}, '$.deletedAt') IS NOT NULL THEN NULL
    WHEN json_extract(${payload}, '$.lineage.relationshipToParent') = 'subagent'
      AND (json_extract(${payload}, '$.lineage.independent') IS NOT 1
        OR json_extract(${payload}, '$.creationSource') = 'provider') THEN NULL
    WHEN json_type(${payload}, '$.groupedUnderThreadId') IS NOT NULL
      THEN CAST(json_extract(${payload}, '$.groupedUnderThreadId') AS TEXT)
    WHEN json_extract(${payload}, '$.createdBy') = 'agent'
      AND json_extract(${payload}, '$.creatorGrouping') = 'grouped'
      AND json_extract(${payload}, '$.lineage.parentThreadId') IS NULL
      AND json_extract(${payload}, '$.lineage.relationshipToParent') IS NULL
      AND json_extract(${payload}, '$.lineage.independent') IS NOT 1
      AND json_extract(${payload}, '$.forkedFrom') IS NULL
      THEN CAST(json_extract(${payload}, '$.creatorThreadId') AS TEXT)
    ELSE NULL END AS TEXT)`;
};
