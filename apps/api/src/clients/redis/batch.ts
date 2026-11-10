import { redisTimeouts } from "../../config/redis-timeouts.js";

export class RedisBatchTimeoutError extends Error {
	constructor() {
		super("Redis batch timed out");
	}
}

export const runRedisBatch = async <T>(operation: (signal: AbortSignal) => Promise<T>) => {

	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {

		timer = setTimeout(() => {
			const error = new RedisBatchTimeoutError();
			reject(error);
			controller.abort(error);
		}, redisTimeouts.batchMs);

	});

	try {
		return await Promise.race([deadline, operation(controller.signal)]);
	} finally {
		clearTimeout(timer);
	}

};
