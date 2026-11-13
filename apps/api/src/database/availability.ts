import { getAvailabilityKey, parseAvailabilityUnit, publishAvailabilityCache, readAvailabilityCache } from "../clients/availability-cache.js";
import type { AvailabilityUnit } from "../clients/types.js";
import type { Clinic, Professional, Service } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { runAuthorizedTransaction } from "./authorization.js";
import {
	calculateDailyAvailability, filterFutureStarts, getAvailabilityTimeReference, getOccupationWindows, prepareAvailabilityCalendar,
} from "./availability-calculation.js";
import {
	availabilityMetadataQuery, availabilityProfessionalsQuery, availabilitySchedulesQuery, availabilityOccupationQuery,
} from "./availability-queries.js";
import type { ScheduleInterval, TransactionClient } from "./types.js";

type AvailabilityQuery = Pick<Service, "serviceId"> & ({ professionalId: string; date: string } | { from: string; to: string });
type AvailabilityMetadata = Pick<Clinic, "timeZone"> & Pick<Service, "serviceId" | "specialtyId" | "durationMinutes"> & { version: string | null };
type ProfessionalEligibility = Pick<Professional, "professionalId"> & { eligible: boolean };
type ProfessionalScheduleInterval = Pick<Professional, "professionalId"> & ScheduleInterval;
type ProfessionalOccupation = Pick<Professional, "professionalId"> & { startAt: Date; endAt: Date };

const readAvailabilityProfessionals = async (
	transaction: TransactionClient, clinicId: string, { serviceId, specialtyId }: AvailabilityMetadata, professionalId?: string,
) => {

	const { rows } = await transaction.query<ProfessionalEligibility>(
		availabilityProfessionalsQuery,
		[clinicId, serviceId, specialtyId, professionalId ?? null],
	);

	return rows;

};

const readAvailabilityScope = async (transaction: TransactionClient, clinicId: string, query: AvailabilityQuery) => {

	const { rows: [metadata] } = await transaction.query<AvailabilityMetadata>(
		availabilityMetadataQuery,
		[clinicId, query.serviceId],
	);
	if(!metadata) {
		throw Object.assign(new Error("Service not found"), { status: 404 });
	}
	const { timeZone, durationMinutes, version, serviceId } = metadata;
	if(version === null) {
		throw new Error("Missing clinic availability version");
	}

	const from = "date" in query ? query.date : query.from;
	const to = "date" in query ? query.date : query.to;
	const professionalId = "professionalId" in query ? query.professionalId : undefined;
	const professionals = await readAvailabilityProfessionals(transaction, clinicId, metadata, professionalId);
	const calendar = prepareAvailabilityCalendar(from, to, timeZone);

	return { scope: { clinicId, serviceId, timeZone, durationMinutes, version }, calendar, professionals };

};

const readAvailabilitySnapshot = async (
	transaction: TransactionClient, clinicId: string, query: AvailabilityQuery, now: Date, cached?: Map<string, string | null>,
) => {

	const { scope, calendar, professionals: eligibility } = await readAvailabilityScope(transaction, clinicId, query);
	const { timeZone, durationMinutes } = scope;
	const timeReference = getAvailabilityTimeReference(timeZone, now);
	const from = "date" in query ? query.date : query.from;
	if(from < timeReference.today) {
		throw Object.assign(new Error("Availability date precedes today in the clinic"), { status: 400 });
	}
	if("professionalId" in query) {

		if(!eligibility[0]) {
			throw Object.assign(new Error("Professional not found"), { status: 404 });
		}
		if(!eligibility[0].eligible) {
			throw Object.assign(new Error("Professional is not eligible for service"), { status: 409 });
		}

	}

	let acceptedUnits = 0;
	const professionals = eligibility.filter(({ eligible }) => eligible).map(({ professionalId }) => {

		const units: AvailabilityUnit[] = [];
		if(!cached) {
			return { professionalId, units, calendar };
		}
		const missingDates = new Map<number, string>();
		for(const [day, localDate] of calendar.dates) {

			const unitScope = { ...scope, professionalId, localDate };
			const unit = parseAvailabilityUnit(cached.get(getAvailabilityKey(unitScope)) ?? null, unitScope);
			if(unit) {
				units.push(unit);
				acceptedUnits++;
			} else {
				missingDates.set(day, localDate);
			}

		}

		return { professionalId, units, calendar: { ...calendar, dates: missingDates } };

	});
	const missing = professionals.filter((professional) => professional.calendar.dates.size > 0);
	const professionalIds = missing.map(({ professionalId }) => professionalId);
	const windows = missing.flatMap(({ professionalId, calendar }) => {
		return getOccupationWindows(calendar, durationMinutes).map((window) => ({ professionalId, ...window }));
	});
	let schedules: ProfessionalScheduleInterval[] = [];
	let occupation: ProfessionalOccupation[] = [];
	if(windows.length > 0) {

		({ rows: schedules } = await transaction.query<ProfessionalScheduleInterval>(
			availabilitySchedulesQuery,
			[clinicId, professionalIds],
		));
		({ rows: occupation } = await transaction.query<ProfessionalOccupation>(
			availabilityOccupationQuery,
			[clinicId, professionalIds, JSON.stringify(windows)],
		));

	}

	const weeksByProfessional = Map.groupBy(schedules, (schedule) => schedule.professionalId);
	const occupationByProfessional = Map.groupBy(occupation, (interval) => interval.professionalId);
	const calculatedUnits: AvailabilityUnit[] = [];
	for(const professional of missing) {

		const { professionalId, calendar } = professional;
		const units = calculateDailyAvailability(
			calendar, weeksByProfessional.get(professionalId) ?? [], occupationByProfessional.get(professionalId) ?? [], durationMinutes,
		);
		for(const unit of units) {
			const calculated = { ...scope, professionalId, ...unit };
			professional.units.push(calculated);
			calculatedUnits.push(calculated);
		}

	}

	return { ...scope, timeReference, dates: [...calendar.dates.values()], professionals, acceptedUnits, calculatedUnits };

};

const buildAvailabilityResponse = (query: AvailabilityQuery, snapshot: Awaited<ReturnType<typeof readAvailabilitySnapshot>>) => {

	const professionalsByDate = new Map<string, { professionalId: string; starts: string[] }[]>();
	for(const date of snapshot.dates) {
		professionalsByDate.set(date, []);
	}
	for(const { professionalId, units } of snapshot.professionals) {

		for(const { localDate, starts } of filterFutureStarts(units, snapshot.timeReference)) {
			if(starts.length > 0) {
				professionalsByDate.get(localDate)!.push({ professionalId, starts });
			}
		}

	}

	const { serviceId } = snapshot;
	if("date" in query) {

		const { professionalId } = snapshot.professionals[0];
		const { date } = query;
		const starts = professionalsByDate.get(date)![0]?.starts ?? [];

		return { professionalId, serviceId, date, starts };

	}
	const dates = [...professionalsByDate].map(([date, professionals]) => ({ date, professionals }));

	return { serviceId, dates };

};

const prepareAvailabilityCache = async (authentication: Authentication, query: AvailabilityQuery) => {

	const scopes = await runAuthorizedTransaction(authentication, { name: "prepareAvailability" }, async (transaction, actor) => {
		const { scope, calendar, professionals } = await readAvailabilityScope(transaction, actor.clinicId!, query);

		return professionals.filter(({ eligible }) => eligible).flatMap(({ professionalId }) => {
			return [...calendar.dates.values()].map((localDate) => ({ ...scope, professionalId, localDate }));
		});

	});

	return readAvailabilityCache(scopes);

};

export const readAvailability = async (authentication: Authentication, query: AvailabilityQuery, useCache: boolean) => {

	const cached = useCache ? await prepareAvailabilityCache(authentication, query) : undefined;
	const { response, acceptedUnits, calculatedUnits } = await runAuthorizedTransaction(authentication, { name: "readDefinitiveAvailability" }, async (transaction, actor) => {
		const snapshot = await readAvailabilitySnapshot(transaction, actor.clinicId!, query, new Date(), cached);

		return { response: buildAvailabilityResponse(query, snapshot), acceptedUnits: snapshot.acceptedUnits, calculatedUnits: snapshot.calculatedUnits };
	});
	if(useCache) {
		await publishAvailabilityCache(calculatedUnits);
	}

	return { response, acceptedUnits, calculatedUnits: calculatedUnits.length };

};
