import type { PoolClient } from "pg";

export type TransactionClient = Pick<PoolClient, "query">;
export type TransactionStage = "acquire" | "begin" | "operation" | "commit";
