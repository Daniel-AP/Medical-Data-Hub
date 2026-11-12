import type { Clinic, Professional, Service } from "../generated/prisma/client.js";
import { createLocalTimeReader } from "../database/schedule-coverage.js";
import { redis, runRedisBatch } from "./redis.js";

type AvailabilityScope = Pick<Clinic, "clinicId" | "timeZone"> & Pick<Professional, "professionalId"> &
	Pick<Service, "serviceId" | "durationMinutes"> & { localDate: string; version: string };
type AvailabilityUnit = AvailabilityScope & { starts: string[] };

const maxUnitBytes = 64*1024;
const unitTtlSeconds = 300;

const isMinuteInstant = (value: unknown): value is string => {

	if(typeof value !== "string" || !value.endsWith(":00.000Z")) {
		return false;
	}
	const instant = Date.parse(value);

	return Number.isFinite(instant) && new Date(instant).toISOString() === value;

};

export const getAvailabilityKey = ({ clinicId, professionalId, serviceId, localDate, version }: AvailabilityScope) => {
	return `availability:${clinicId}:${professionalId}:${serviceId}:${localDate}:${version}`;
};

export const parseAvailabilityUnit = (value: string | null, scope: AvailabilityScope) => {

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

	const readLocalTime = createLocalTimeReader(scope.timeZone);
	const requestedDay = Date.parse(scope.localDate);
	const starts = new Set<string>();
	for(const start of unit.starts) {

		if(!isMinuteInstant(start)) {
			return null;
		}
		const local = readLocalTime(Date.parse(start));
		if(local.date.setUTCHours(0, 0, 0, 0) !== requestedDay) {
			return null;
		}
		starts.add(start);

	}

	return { ...scope, starts: [...starts].sort((left, right) => Date.parse(left)-Date.parse(right)) };

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
