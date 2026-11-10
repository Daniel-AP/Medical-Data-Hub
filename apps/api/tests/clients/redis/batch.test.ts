import { afterEach, expect, it, vi } from "vitest";

vi.stubEnv("REDIS_BATCH_TIMEOUT_MS", "500");
const { RedisBatchTimeoutError, runRedisBatch } = await import("../../../src/clients/redis/batch.js");
vi.unstubAllEnvs();

afterEach(() => {
	vi.useRealTimers();
});

it("returns successful Redis batch results with an independent deadline per batch", async () => {

	vi.useFakeTimers();
	const operation = async (signal: AbortSignal) => {
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
		expect(signal.aborted).toBe(false);

		return "available";
	};

	for(let batch = 0; batch < 2; batch++) {
		const result = runRedisBatch(operation);
		await vi.advanceTimersByTimeAsync(300);
		await expect(result).resolves.toBe("available");
	}
	expect(vi.getTimerCount()).toBe(0);

});

it("signals a Redis batch timeout and discards a late result", async () => {

	vi.useFakeTimers();
	const late = Promise.withResolvers<string>();
	const operation = vi.fn<(signal: AbortSignal) => Promise<string>>(() => late.promise);
	const result = runRedisBatch(operation);
	const rejected = expect(result).rejects.toBeInstanceOf(RedisBatchTimeoutError);

	await vi.advanceTimersByTimeAsync(500);
	await rejected;
	const [[signal]] = operation.mock.calls;
	expect(signal.aborted).toBe(true);

	late.resolve("late value");
	await expect(late.promise).resolves.toBe("late value");
	await expect(result).rejects.toBe(signal.reason);

});
