import type { Clinic, Professional, Service } from "../generated/prisma/client.js";
import type { Authentication } from "../middleware/types.js";
import { runAuthorizedTransaction } from "./authorization.js";
import {
	calculateDailyAvailability, filterFutureStarts, getAvailabilityTimeReference, getOccupationWindows, prepareAvailabilityCalendar,
} from "./availability-calculation.js";
import type { ScheduleInterval, TransactionClient } from "./types.js";

type AvailabilityQuery = Pick<Service, "serviceId"> & ({ professionalId: string; date: string } | { from: string; to: string });
type AvailabilityMetadata = Pick<Clinic, "timeZone"> & Pick<Service, "serviceId" | "specialtyId" | "durationMinutes"> & { version: string | null };
type ProfessionalEligibility = Pick<Professional, "professionalId"> & { eligible: boolean };
type ProfessionalScheduleInterval = Pick<Professional, "professionalId"> & ScheduleInterval;
type ProfessionalOccupation = Pick<Professional, "professionalId"> & { startAt: Date; endAt: Date };

const readEligibleProfessionals = async (
	transaction: TransactionClient, clinicId: string, { serviceId, specialtyId }: AvailabilityMetadata, professionalId?: string,
) => {

	const { rows } = await transaction.query<ProfessionalEligibility>(
		`WITH candidates AS (
		     SELECT professional.professional_id,
		            COALESCE(association.is_active AND professional.specialty_id = $3::uuid
		                     AND account.is_active AND account.role = 'healthcare_professional', false) AS eligible
		     FROM public.professionals AS professional
		     JOIN public.users AS account USING (clinic_id, user_id)
		     LEFT JOIN public.professional_services AS association
		       ON association.clinic_id = professional.clinic_id AND association.professional_id = professional.professional_id
		       AND association.service_id = $2::uuid
		     WHERE professional.clinic_id = $1::uuid AND ($4::uuid IS NULL OR professional.professional_id = $4)
		 )
		 SELECT professional_id AS "professionalId", eligible FROM candidates
		 WHERE $4::uuid IS NOT NULL OR eligible ORDER BY professional_id`,
		[clinicId, serviceId, specialtyId, professionalId ?? null],
	);
	if(professionalId !== undefined) {

		if(!rows[0]) {
			throw Object.assign(new Error("Professional not found"), { status: 404 });
		}
		if(!rows[0].eligible) {
			throw Object.assign(new Error("Professional is not eligible for service"), { status: 409 });
		}

	}

	return rows.map((row) => row.professionalId);

};

const readAvailabilitySnapshot = async (transaction: TransactionClient, clinicId: string, query: AvailabilityQuery, now: Date) => {

	const { rows: [metadata] } = await transaction.query<AvailabilityMetadata>(
		`SELECT service.service_id AS "serviceId", service.specialty_id AS "specialtyId",
		        service.duration_minutes AS "durationMinutes", clinic.time_zone AS "timeZone", availability.version::text AS version
		 FROM public.clinics AS clinic
		 JOIN public.services AS service USING (clinic_id)
		 LEFT JOIN public.clinic_availability_versions AS availability USING (clinic_id)
		 WHERE clinic.clinic_id = $1::uuid AND service.service_id = $2::uuid`,
		[clinicId, query.serviceId],
	);
	if(!metadata) {
		throw Object.assign(new Error("Service not found"), { status: 404 });
	}
	const { timeZone, durationMinutes, version, serviceId } = metadata;
	if(version === null) {
		throw new Error("Missing clinic availability version");
	}

	const timeReference = getAvailabilityTimeReference(timeZone, now);
	const from = "date" in query ? query.date : query.from;
	const to = "date" in query ? query.date : query.to;
	if(from < timeReference.today) {
		throw Object.assign(new Error("Availability date precedes today in the clinic"), { status: 400 });
	}

	const professionalId = "professionalId" in query ? query.professionalId : undefined;
	const professionalIds = await readEligibleProfessionals(transaction, clinicId, metadata, professionalId);
	const calendar = prepareAvailabilityCalendar(from, to, timeZone);
	const windows = getOccupationWindows(calendar, durationMinutes);
	let schedules: ProfessionalScheduleInterval[] = [];
	let occupation: ProfessionalOccupation[] = [];
	if(professionalIds.length > 0 && windows.length > 0) {

		({ rows: schedules } = await transaction.query<ProfessionalScheduleInterval>(
			`SELECT professional_id AS "professionalId", weekday, start_minute AS "startMinute", end_minute AS "endMinute"
			 FROM public.professional_schedules WHERE clinic_id = $1::uuid AND professional_id = ANY($2::uuid[])`,
			[clinicId, professionalIds],
		));
		({ rows: occupation } = await transaction.query<ProfessionalOccupation>(
			`WITH search_windows AS (
			     SELECT to_timestamp(span.start/1000.0) AS start_at, to_timestamp(span."end"/1000.0) AS end_at
			     FROM jsonb_to_recordset($3::jsonb) AS span(start bigint, "end" bigint)
			 )
			 SELECT appointment.professional_id AS "professionalId", appointment.start_at AS "startAt", appointment.end_at AS "endAt"
			 FROM public.appointments AS appointment
			 WHERE appointment.clinic_id = $1::uuid AND appointment.professional_id = ANY($2::uuid[])
			   AND appointment.state = 'reserved'
			   AND EXISTS (SELECT 1 FROM search_windows WHERE appointment.start_at < end_at AND appointment.end_at > start_at)
			 UNION ALL
			 SELECT block.professional_id AS "professionalId", block.start_at AS "startAt", block.end_at AS "endAt"
			 FROM public.professional_blocks AS block
			 WHERE block.clinic_id = $1::uuid AND block.professional_id = ANY($2::uuid[])
			   AND EXISTS (SELECT 1 FROM search_windows WHERE block.start_at < end_at AND block.end_at > start_at)`,
			[clinicId, professionalIds, JSON.stringify(windows)],
		));

	}

	const weeksByProfessional = Map.groupBy(schedules, (schedule) => schedule.professionalId);
	const occupationByProfessional = Map.groupBy(occupation, (interval) => interval.professionalId);
	const professionals = professionalIds.map((id) => ({
		professionalId: id,
		units: calculateDailyAvailability(calendar, weeksByProfessional.get(id) ?? [], occupationByProfessional.get(id) ?? [], durationMinutes),
	}));

	return { clinicId, serviceId, timeZone, durationMinutes, version, timeReference, dates: [...calendar.dates.values()], professionals };

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

export const readAvailability = (authentication: Authentication, query: AvailabilityQuery) => {

	return runAuthorizedTransaction(authentication, { name: "readDefinitiveAvailability" }, async (transaction, actor) => {
		const snapshot = await readAvailabilitySnapshot(transaction, actor.clinicId!, query, new Date());

		return buildAvailabilityResponse(query, snapshot);
	});

};
