import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

type Mode = "direct" | "cached";

type Workload = {
	name: string;
	url: URL;
	expectedUnits: number;
};

const warmupCount = 3;
const pairCount = 10;
const requestTimeoutMs = 15_000;
const modes: readonly Mode[] = ["direct", "cached"];

export const protocol = { warmupCount, pairCount, requestTimeoutMs };

const readCacheUsage = (header: string | null) => {

	const match = header?.match(/^mode=(direct|cached), accepted=(\d+), calculated=(\d+)$/);
	if(!match) {
		return null;
	}

	return { mode: match[1], accepted: Number(match[2]), calculated: Number(match[3]) };

};

const requestAvailability = async (url: URL, token: string, mode: Mode, signal: AbortSignal) => {

	const options = {
		headers: { Authorization: "Bearer "+token, "Availability-Mode": mode },
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
	} satisfies RequestInit;
	let status: number | null = null;
	let cacheHeader: string | null = null;
	let bytes: ArrayBuffer;
	const startedAt = performance.now();
	try {
		const response = await fetch(url, options);
		status = response.status;
		cacheHeader = response.headers.get("Availability-Cache");
		bytes = await response.arrayBuffer();
	} catch(error) {
		const durationMs = performance.now()-startedAt;
		const errorName = error instanceof Error ? error.name : "Error";

		return { mode, durationMs, status, cacheUsage: readCacheUsage(cacheHeader), error: errorName };
	}
	const durationMs = performance.now()-startedAt;
	const cacheUsage = readCacheUsage(cacheHeader);
	const bodyHash = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
	try {
		const body: unknown = JSON.parse(new TextDecoder().decode(bytes));

		return { mode, durationMs, status, cacheUsage, bodyHash, body };
	} catch {
		return { mode, durationMs, status, cacheUsage, bodyHash, error: "Invalid JSON response" };
	}

};

type Sample = Awaited<ReturnType<typeof requestAvailability>>;
type Pair = {
	number: number;
	samples: (Omit<Sample, "body"> & { body?: unknown })[];
	responsesEqual: boolean | null;
	included: boolean;
	issues: string[];
};

const sampleIssue = (sample: Sample, expectedUnits: number) => {

	if(sample.error) {
		return sample.error;
	}
	if(sample.status !== 200) {
		return `HTTP ${sample.status}`;
	}
	const expectedAccepted = sample.mode === "cached" ? expectedUnits : 0;
	const usage = sample.cacheUsage;
	if(usage?.mode !== sample.mode || usage.accepted !== expectedAccepted || usage.calculated !== expectedUnits-expectedAccepted) {
		return "Unexpected cache usage";
	}

	return null;

};

const prepareWorkload = async (workload: Workload, token: string, signal: AbortSignal) => {

	const { name, url, expectedUnits } = workload;
	const fill = await requestAvailability(url, token, "cached", signal);
	if(fill.error || fill.status !== 200) {
		throw new Error(`${name} cache preparation failed (${fill.error ?? "HTTP "+fill.status})`);
	}
	const verified = await requestAvailability(url, token, "cached", signal);
	const cacheIssue = sampleIssue(verified, expectedUnits);
	if(cacheIssue) {
		throw new Error(`${name} cache verification failed (${cacheIssue})`);
	}

	for(const mode of modes) {

		for(let index = 0; index < warmupCount; index++) {
			const sample = await requestAvailability(url, token, mode, signal);
			const issue = sampleIssue(sample, expectedUnits);
			if(issue) {
				throw new Error(`${name} ${mode} warm-up failed (${issue})`);
			}
		}

	}

	return verified.cacheUsage;

};

export const measureWorkload = async (workload: Workload, token: string, signal: AbortSignal) => {

	const { name, url, expectedUnits } = workload;
	const preparedCache = await prepareWorkload(workload, token, signal);
	const pairs: Pair[] = [];
	for(let number = 1; number <= pairCount; number++) {

		signal.throwIfAborted();
		const firstMode = number%2 === 1 ? "direct" : "cached";
		const secondMode = firstMode === "direct" ? "cached" : "direct";
		const first = await requestAvailability(url, token, firstMode, signal);
		const second = await requestAvailability(url, token, secondMode, signal);
		const responsesEqual = "body" in first && "body" in second ? isDeepStrictEqual(first.body, second.body) : null;
		const issues = [first, second].flatMap((sample) => {
			const issue = sampleIssue(sample, expectedUnits);

			return issue ? [`${sample.mode}: ${issue}`] : [];
		});
		if(responsesEqual === false) {
			issues.push("Response bodies differ");
		}
		const samples = [first, second].map(({ body, ...sample }) => {
			// Keep differing availability responses and hashes without recording arbitrary error bodies.
			return responsesEqual === false && sample.status === 200 ? { ...sample, body } : sample;
		});
		pairs.push({ number, samples, responsesEqual, included: issues.length === 0, issues });

	}

	const aggregates = modes.map((mode) => {

		const durations = pairs.filter(({ included }) => included).flatMap(({ samples }) =>
			samples.filter((sample) => sample.mode === mode).map(({ durationMs }) => durationMs),
		).sort((left, right) => left-right);
		const count = durations.length;
		const middle = Math.floor(count/2);
		const meanMs = count ? durations.reduce((sum, duration) => sum+duration, 0)/count : null;
		const medianMs = count ? (durations[Math.floor((count-1)/2)]+durations[middle])/2 : null;

		return { mode, count, meanMs, medianMs };

	});

	return { name, path: url.pathname+url.search, expectedUnits, preparedCache, pairs, aggregates };

};
