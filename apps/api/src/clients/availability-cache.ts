import { redis, runRedisBatch } from "./redis.js";
import type { AvailabilityScope, AvailabilityUnit } from "./types.js";

const maxUnitBytes = 64*1024;
const unitTtlSeconds = 300;
const utcMinuteSuffixLength = 14;
const utcMinuteSuffix = /^T(?:[01][0-9]|2[0-3]):[0-5][0-9]:00\.000Z$/;

export const getAvailabilityKey = ({ clinicId, professionalId, serviceId, localDate, version }: AvailabilityScope) => {
	return `availability:${clinicId}:${professionalId}:${serviceId}:${localDate}:${version}`;
};

export const parseAvailabilityUnit = (
	value: string | null, scope: AvailabilityScope, spans: readonly { start: number; end: number }[],
) => {

	if(value === null || Buffer.byteLength(value, "utf8") > maxUnitBytes) {
		return null;
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(value);
	} catch {
		return null;
	}

	if(decoded === null || typeof decoded !== "object") {
		return null;
	}
	const unit = decoded as Record<string, unknown>;
	const matchesScope = unit.clinicId === scope.clinicId &&
		unit.professionalId === scope.professionalId &&
		unit.serviceId === scope.serviceId &&
		unit.localDate === scope.localDate &&
		unit.version === scope.version &&
		unit.timeZone === scope.timeZone &&
		unit.durationMinutes === scope.durationMinutes;
	if(!matchesScope || !Array.isArray(unit.starts)) {
		return null;
	}

	const utcMidnights = new Map<string, number>();
	const starts = new Map<number, string>();
	for(const start of unit.starts) {

		if(typeof start !== "string") {
			return null;
		}
		const suffix = start.slice(-utcMinuteSuffixLength);
		if(!utcMinuteSuffix.test(suffix)) {
			return null;
		}

		const utcDate = start.slice(0, -utcMinuteSuffixLength);
		let midnight = utcMidnights.get(utcDate);
		if(midnight === undefined) {

			const midnightIso = utcDate+"T00:00:00.000Z";
			midnight = Date.parse(midnightIso);
			if(!Number.isFinite(midnight) || new Date(midnight).toISOString() !== midnightIso) {
				return null;
			}
			utcMidnights.set(utcDate, midnight);

		}
		const minute = Number(suffix.slice(1, 3))*60+Number(suffix.slice(4, 6));
		const instant = midnight+minute*60_000;
		if(!spans.some(({ start, end }) => instant >= start && instant < end)) {
			return null;
		}
		starts.set(instant, start);

	}
	const sortedStarts = [...starts].sort(([left], [right]) => left-right).map(([, start]) => start);

	return { ...scope, starts: sortedStarts };

};

export const serializeAvailabilityUnit = (unit: AvailabilityUnit) => {
	const value = JSON.stringify(unit);

	return Buffer.byteLength(value, "utf8") <= maxUnitBytes ? value : null;
};

export const readAvailabilityCache = async (scopes: AvailabilityScope[]) => {

	const entries = new Map<string, string | null>();
	if(scopes.length === 0 || !redis.isReady) {
		return entries;
	}

	try {
		const keys = scopes.map(getAvailabilityKey);
		const values = await runRedisBatch((signal) => redis.withAbortSignal(signal).mGet(keys));

		return new Map(keys.map((key, index) => [key, values[index]]));
	} catch {
		console.error("Availability cache lookup failed");

		return entries;
	}

};

export const publishAvailabilityCache = async (units: AvailabilityUnit[]) => {

	if(units.length === 0 || !redis.isReady) {
		return;
	}

	try {

		const pipeline = redis.multi();
		for(const unit of units) {

			const value = serializeAvailabilityUnit(unit);
			if(value !== null) {
				pipeline.set(getAvailabilityKey(unit), value, { expiration: { type: "EX", value: unitTtlSeconds } });
			}

		}
		// Sent publications may finish after the deadline
		await runRedisBatch(() => pipeline.execAsPipeline());

	} catch {
		console.error("Availability cache publication failed");
	}

};
