import type { PoolClient } from "pg";

export type TransactionClient = Pick<PoolClient, "query">;
