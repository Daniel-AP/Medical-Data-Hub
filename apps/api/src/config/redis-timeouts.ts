import { readTimeout } from "./read-timeout.js";

export const redisTimeouts = {
	batchMs: readTimeout("REDIS_BATCH_TIMEOUT_MS", 500),
};
