import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client, Pool } from "pg";
import { getOccupationWindows, prepareAvailabilityCalendar } from "../src/database/availability-calculation.js";
import {
	availabilityMetadataQuery, availabilityProfessionalsQuery, availabilitySchedulesQuery, availabilityOccupationQuery,
} from "../src/database/availability-queries.js";
import { runAuthorizedTransaction } from "../src/database/authorization.js";
import type { ScheduleInterval } from "../src/database/types.js";
import type { Appointment, Clinic, Professional, Service } from "../src/generated/prisma/client.js";
import { UserRole } from "../src/generated/prisma/enums.js";
import type { Authentication } from "../src/middleware/types.js";

type ExecutionPlan = { "Execution Time": number; [key: string]: unknown };
type Statement = { sql: string; parameters: unknown[] };
type ReadQuery = Statement & { name: string; scenario: string };
type EvaluationQuery = {
	name: string;
	scenario?: string;
	statements: Statement[];
	authentication: Authentication;
	operation: Parameters<typeof runAuthorizedTransaction>[1];
	rollback: boolean;
};
type IndexSize = { name: string; bytes: number };

const realm = JSON.parse(readFileSync(new URL("../../../infra/keycloak/development/medical-data-hub-realm.json", import.meta.url), "utf8")) as {
	users: { id: string; username: string }[];
};
const receptionAccount = realm.users.find(({ username }) => username === "reception");
const administratorAccount = realm.users.find(({ username }) => username === "clinic-administrator");
if(!receptionAccount || !administratorAccount) {
	throw new Error("Evaluation accounts missing");
}
const reception = { identityId: receptionAccount.id, roles: [UserRole.reception] };
const administrator = { identityId: administratorAccount.id, roles: [UserRole.clinicAdministrator] };
const pool = new Pool({ connectionString: process.env.API_DATABASE_URL });
const setup = new Client({ connectionString: process.env.DATABASE_URL });
const output = new URL("../../../performance/indexes/", import.meta.url);
const warmupRuns = 3;
const measuredRuns = 10;
const references = new Map<string, string[]>();
const indexes = {
	"appointments-end": { name: "appointments_reserved_end_idx", table: "appointments", columns: "clinic_id, professional_id, end_at", predicate: " WHERE state = 'reserved'" },
	"appointments-start": { name: "appointments_reserved_start_idx", table: "appointments", columns: "clinic_id, professional_id, start_at", predicate: " WHERE state = 'reserved'" },
	"appointments-professional": { name: "appointments_reserved_idx", table: "appointments", columns: "clinic_id, professional_id", predicate: " WHERE state = 'reserved'" },
	"blocks-end": { name: "professional_blocks_end_idx", table: "professional_blocks", columns: "clinic_id, professional_id, end_at", predicate: "" },
	"blocks-start": { name: "professional_blocks_start_idx", table: "professional_blocks", columns: "clinic_id, professional_id, start_at", predicate: "" },
	"blocks-professional": { name: "professional_blocks_idx", table: "professional_blocks", columns: "clinic_id, professional_id", predicate: "" },
	schedules: { name: "professional_schedules_idx", table: "professional_schedules", columns: "clinic_id, professional_id", predicate: "" },
	associations: { name: "professional_services_active_idx", table: "professional_services", columns: "clinic_id, service_id, professional_id", predicate: " WHERE is_active" },
};
const configurations: { name: string; indexes: (keyof typeof indexes)[]; reads: string[]; writes: string[] }[] = [
	{ name: "existing-indexes", indexes: [], reads: ["metadata", "professionals", "schedules", "occupation"], writes: ["insert-appointment", "cancel-appointment", "insert-block", "replace-schedules", "deactivate-association"] },
	...(["appointments-end", "appointments-start", "appointments-professional"] as const).map((name) => ({ name, indexes: [name], reads: ["occupation"], writes: ["insert-appointment", "cancel-appointment"] })),
	...(["blocks-end", "blocks-start", "blocks-professional"] as const).map((name) => ({ name, indexes: [name], reads: ["occupation"], writes: ["insert-block"] })),
	{ name: "schedules", indexes: ["schedules"], reads: ["schedules"], writes: ["replace-schedules"] },
	{ name: "associations", indexes: ["associations"], reads: ["professionals"], writes: ["deactivate-association"] },
	{ name: "combined-end", indexes: ["appointments-end", "blocks-end", "schedules", "associations"], reads: ["metadata", "professionals", "schedules", "occupation"], writes: ["insert-appointment", "cancel-appointment", "insert-block", "replace-schedules", "deactivate-association"] },
	{ name: "combined-start", indexes: ["appointments-start", "blocks-professional", "schedules"], reads: ["metadata", "professionals", "schedules", "occupation"], writes: ["insert-appointment", "cancel-appointment", "insert-block", "replace-schedules"] },
	{ name: "combined-professional", indexes: ["appointments-professional", "blocks-professional", "schedules"], reads: ["metadata", "professionals", "schedules", "occupation"], writes: ["insert-appointment", "cancel-appointment", "insert-block", "replace-schedules"] },
];

const measureQuery = async (configuration: string, indexSizes: IndexSize[], query: EvaluationQuery) => {

	const result = await runAuthorizedTransaction(query.authentication, query.operation, async (transaction) => {

		let resultRows: string[] | undefined;
		if(!query.rollback) {
			const { sql, parameters } = query.statements[0];
			const { rows } = await transaction.query<Record<string, unknown>>(sql, parameters);
			resultRows = rows.map((row) => JSON.stringify(row)).sort();
		}

		const plans: ExecutionPlan[] = [];
		const samples: number[] = [];
		for(let run = 0; run < warmupRuns+measuredRuns; run++) {

			if(query.rollback) {
				await transaction.query("SAVEPOINT evaluation_write");
			}
			const explanations: ExecutionPlan[] = [];
			for(const { sql, parameters } of query.statements) {

				const { rows } = await transaction.query<{ "QUERY PLAN": ExecutionPlan[] }>(
					`EXPLAIN (ANALYZE, BUFFERS, SETTINGS, TIMING OFF, FORMAT JSON) ${sql}`, parameters,
				);
				explanations.push(rows[0]["QUERY PLAN"][0]);

			}
			if(run >= warmupRuns) {
				samples.push(explanations.reduce((sum, plan) => sum+plan["Execution Time"], 0));
			}
			if(run === warmupRuns) {
				plans.push(...explanations);
			}
			if(query.rollback) {
				await transaction.query("ROLLBACK TO SAVEPOINT evaluation_write");
				await transaction.query("RELEASE SAVEPOINT evaluation_write");
			}

		}

		return { plans, samples, resultRows };

	}, pool);
	if(result.resultRows) {

		const key = `${query.name}/${query.scenario}`;
		if(configuration === "existing-indexes") {
			references.set(key, result.resultRows);
		} else {
			assert.deepEqual(result.resultRows, references.get(key), `Query results changed for ${configuration}/${key}`);
		}

	}

	const directory = new URL(`${configuration}/`, output);
	const name = query.scenario ? `${query.name}-${query.scenario}` : query.name;
	mkdirSync(directory, { recursive: true });
	writeFileSync(new URL(`${name}-plan.json`, directory), JSON.stringify({
		indexes: indexSizes,
		statements: query.statements.map((statement, index) => ({ ...statement, plan: result.plans[index] })),
	}, null, 2)+"\n");
	writeFileSync(new URL(`${name}-samples.csv`, directory), [
		"run,executionMs", ...result.samples.map((sample, index) => `${index+1},${sample.toFixed(3)}`),
	].join("\n")+"\n");

};

const readFixtureCounts = async () => {

	const { rows: [counts] } = await setup.query<Record<string, number>>(`SELECT
		(SELECT count(*)::integer FROM public.appointments) AS appointments,
		(SELECT count(*)::integer FROM public.appointments WHERE state = 'reserved') AS reserved,
		(SELECT count(*)::integer FROM public.professional_blocks) AS blocks,
		(SELECT count(*)::integer FROM public.professional_schedules) AS schedules,
		(SELECT count(*)::integer FROM public.professional_services) AS associations,
		(SELECT count(*)::integer FROM public.professional_services WHERE is_active) AS active`);

	return counts;

};

try {

	await setup.connect();
	const counts = await readFixtureCounts();
	const fixture = await runAuthorizedTransaction(reception, { name: "readDefinitiveAvailability" }, async (transaction, actor) => {

		const { clinicId, userId } = actor;
		const { rows: [{ serviceId }] } = await transaction.query<Pick<Service, "serviceId">>(
			`SELECT service_id AS "serviceId" FROM public.services
			 WHERE clinic_id = $1::uuid AND duration_minutes = 30 ORDER BY service_id LIMIT 1`, [clinicId],
		);
		const { rows: [metadata] } = await transaction.query<Pick<Clinic, "timeZone"> & Pick<Service, "specialtyId" | "durationMinutes">>(
			availabilityMetadataQuery, [clinicId, serviceId],
		);
		const { rows: professionals } = await transaction.query<Pick<Professional, "professionalId">>(
			availabilityProfessionalsQuery, [clinicId, serviceId, metadata.specialtyId, null],
		);
		const professionalId = professionals[0].professionalId;
		const professionalIds = professionals.map(({ professionalId }) => professionalId);
		const { rows: [{ date }] } = await transaction.query<{ date: string }>(
			`SELECT (date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE $1)+INTERVAL '14 days')::date::text AS date`,
			[metadata.timeZone],
		);
		const weekEnd = new Date(Date.parse(date)+6*86_400_000).toISOString().slice(0, 10);
		const reads: ReadQuery[] = [
			{ name: "metadata", scenario: "clinic-service", sql: availabilityMetadataQuery, parameters: [clinicId, serviceId] },
			...[professionalId, null].map((id) => ({ name: "professionals", scenario: id ? "professional" : "service", sql: availabilityProfessionalsQuery, parameters: [clinicId, serviceId, metadata.specialtyId, id] })),
			...[[professionalId], professionalIds].map((ids) => ({ name: "schedules", scenario: ids.length === 1 ? "professional" : "service", sql: availabilitySchedulesQuery, parameters: [clinicId, ids] })),
		];
		for(const { scenario, ids } of [{ scenario: "professional", ids: [professionalId] }, { scenario: "service", ids: professionalIds }]) {

			for(const { period, to } of [{ period: "day", to: date }, { period: "week", to: weekEnd }]) {

				const calendar = prepareAvailabilityCalendar(date, to, metadata.timeZone);
				const windows = ids.flatMap((id) => {
					return getOccupationWindows(calendar, metadata.durationMinutes).map((window) => ({ professionalId: id, ...window }));
				});
				reads.push({ name: "occupation", scenario: `${scenario}-${period}`, sql: availabilityOccupationQuery, parameters: [clinicId, ids, JSON.stringify(windows)] });

			}

		}

		return { clinicId, userId, professionalId, serviceId, date, reads };

	}, pool);
	const { clinicId, userId, professionalId, serviceId, date, reads } = fixture;
	const { rows: [appointment] } = await setup.query<Pick<Appointment, "appointmentId" | "patientId">>(
		`SELECT appointment_id AS "appointmentId", patient_id AS "patientId" FROM public.appointments
		 WHERE clinic_id = $1::uuid AND professional_id = $2::uuid AND state = 'reserved'
		   AND start_at > CURRENT_TIMESTAMP ORDER BY start_at LIMIT 1`, [clinicId, professionalId],
	);
	const { rows: intervals } = await setup.query<ScheduleInterval>(
		`SELECT weekday, start_minute AS "startMinute", end_minute AS "endMinute" FROM public.professional_schedules
		 WHERE clinic_id = $1::uuid AND professional_id = $2::uuid ORDER BY weekday, start_minute`, [clinicId, professionalId],
	);
	const startAt = new Date(Date.parse(`${date}T14:00:00Z`)+420*86_400_000);
	const endAt = new Date(startAt.getTime()+30*60_000);
	const writes: EvaluationQuery[] = [
		{
			name: "insert-appointment", authentication: reception, operation: { name: "createAppointment", professionalId }, rollback: true,
			statements: [{
				sql: `INSERT INTO public.appointments (clinic_id, professional_id, patient_id, service_id, start_at, end_at, previous_appointment_id)
				 SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::timestamptz, $7::uuid
				 WHERE $5::timestamptz > clock_timestamp() AND EXTRACT(SECOND FROM $5::timestamptz AT TIME ZONE 'UTC') = 0
				 RETURNING appointment_id AS "appointmentId"`,
				parameters: [clinicId, professionalId, appointment.patientId, serviceId, startAt, endAt, null],
			}],
		},
		{
			name: "cancel-appointment", authentication: reception, operation: { name: "cancelAppointment" }, rollback: true,
			statements: [{
				sql: `UPDATE public.appointments SET state = 'cancelled', cancellation_reason = $2::text, cancelled_by_user_id = $3::uuid
				 WHERE appointment_id = $1::uuid`,
				parameters: [appointment.appointmentId, "Evaluation cancellation", userId],
			}],
		},
		{
			name: "insert-block", authentication: administrator, operation: { name: "createProfessionalBlock" }, rollback: true,
			statements: [{
				sql: `INSERT INTO public.professional_blocks (clinic_id, professional_id, start_at, end_at)
				 VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz)
				 RETURNING professional_block_id AS "professionalBlockId"`,
				parameters: [clinicId, professionalId, startAt, endAt],
			}],
		},
		{
			name: "replace-schedules", authentication: administrator, operation: { name: "replaceWeeklySchedule" }, rollback: true,
			statements: [
				{ sql: "DELETE FROM public.professional_schedules WHERE professional_id = $1::uuid", parameters: [professionalId] },
				{
					sql: `INSERT INTO public.professional_schedules (clinic_id, professional_id, weekday, start_minute, end_minute)
					 SELECT $1::uuid, $2::uuid, weekday, "startMinute", "endMinute"
					 FROM jsonb_to_recordset($3::jsonb) AS interval(weekday smallint, "startMinute" smallint, "endMinute" smallint)`,
					parameters: [clinicId, professionalId, JSON.stringify(intervals)],
				},
			],
		},
		{
			name: "deactivate-association", authentication: administrator, operation: { name: "updateProfessionalServiceActivity" }, rollback: true,
			statements: [{
				sql: `UPDATE public.professional_services SET is_active = $4::boolean
				 WHERE clinic_id = $1::uuid AND professional_id = $2::uuid AND service_id = $3::uuid
				 RETURNING professional_id AS "professionalId", service_id AS "serviceId", is_active AS "isActive"`,
				parameters: [clinicId, professionalId, serviceId, false],
			}],
		},
	];
	for(const configuration of configurations) {

		const indexSizes: IndexSize[] = [];
		for(const key of configuration.indexes) {

			const index = indexes[key];
			await setup.query(`CREATE INDEX ${index.name} ON public.${index.table} (${index.columns})${index.predicate}`);
			const { rows: [{ bytes }] } = await setup.query<{ bytes: number }>(
				`SELECT pg_relation_size($1::regclass)::integer AS bytes`, [`public.${index.name}`],
			);
			indexSizes.push({ name: index.name, bytes });

		}

		for(const { name, scenario, sql, parameters } of reads.filter(({ name }) => configuration.reads.includes(name))) {

			await measureQuery(configuration.name, indexSizes, {
				name, scenario, statements: [{ sql, parameters }], authentication: reception,
				operation: { name: "readDefinitiveAvailability" }, rollback: false,
			});

		}

		for(const query of writes.filter(({ name }) => configuration.writes.includes(name))) {
			await measureQuery(configuration.name, indexSizes, query);
		}

		for(const key of configuration.indexes) {
			await setup.query(`DROP INDEX public.${indexes[key].name}`);
		}

		console.log(`Measured ${configuration.name}`);

	}
	assert.deepEqual(await readFixtureCounts(), counts, "Write measurements changed the fixture");
	const { rows: remaining } = await setup.query(
		`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
		[Object.values(indexes).map(({ name }) => name)],
	);
	assert.equal(remaining.length, 0, "Evaluation indexes remain installed");
	console.log("Measurements checked");

} finally {
	await setup.end();
	await pool.end();
}
