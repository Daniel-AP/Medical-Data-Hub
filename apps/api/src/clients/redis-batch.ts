import { redisBatchTimeoutMs } from "../config/redis-timeout.js";

export class RedisBatchTimeoutError extends Error {
	constructor() {
		super("Redis batch timed out");
	}
}

export async function runRedisBatch<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new RedisBatchTimeoutError();
			reject(error);
			controller.abort(error);
		}, redisBatchTimeoutMs);
	});

	try {
		return await Promise.race([deadline, operation(controller.signal)]);
	} finally {
		clearTimeout(timer);
	}
}
