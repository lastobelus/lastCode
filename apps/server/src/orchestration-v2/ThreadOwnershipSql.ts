import type * as SqlClient from "effect/sql/SqlClient";

const isOwnedSubagentSql = (sql: SqlClient.SqlClient, alias: string) => {
  const payload = sql.literal(`${alias}.payload_json`);
  return sql`json_extract(${payload}, '$.lineage.relationshipToParent') IS 'subagent'
    AND json_extract(${payload}, '$.lineage.independent') IS NOT 1`;
};

// SQL counterpart of isOwnedSubagentThread and its local lineage parent.
export const ownedSubagentParentSql = (sql: SqlClient.SqlClient, alias: string) => {
  const payload = sql.literal(`${alias}.payload_json`);
  return sql`CASE WHEN ${isOwnedSubagentSql(sql, alias)}
    THEN json_extract(${payload}, '$.lineage.parentThreadId') END`;
};

// Match the lineage used by the sidebar snapshot when it trims older settled threads.
export const isListedThreadLineageSql = (sql: SqlClient.SqlClient, alias: string) => {
  const payload = sql.literal(`${alias}.payload_json`);
  return sql`json_extract(${payload}, '$.lineage.sideChat') IS NOT 1
    AND NOT (${isOwnedSubagentSql(sql, alias)})`;
};
