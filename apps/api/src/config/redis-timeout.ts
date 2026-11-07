import { readTimeout } from "./read-timeout.js";

export const redisBatchTimeoutMs = readTimeout("REDIS_BATCH_TIMEOUT_MS", 500);
