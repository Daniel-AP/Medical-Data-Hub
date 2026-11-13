import { readFileSync, writeFileSync } from "node:fs";
import { Client, Pool } from "pg";
import { getOccupationWindows, prepareAvailabilityCalendar } from "../src/database/availability-calculation.js";
import {
	availabilityMetadataQuery, availabilityProfessionalsQuery, availabilitySchedulesQuery, availabilityOccupationQuery,
} from "../src/database/availability-queries.js";
import { runAuthorizedTransaction } from "../src/database/authorization.js";
import type { TransactionClient } from "../src/database/types.js";
import type { Clinic, Professional, Service } from "../src/generated/prisma/client.js";
import { UserRole } from "../src/generated/prisma/enums.js";

type ExecutionPlan = { "Execution Time": number; [key: string]: unknown };
type EvaluationQuery = { scenario: string; name: string; sql: string; parameters: unknown[] };

const realm = JSON.parse(readFileSync(new URL("../../../infra/keycloak/development/medical-data-hub-realm.json", import.meta.url), "utf8")) as {
	users: { id: string; username: string }[];
};
const reception = realm.users.find(({ username }) => username === "reception");
if(!reception) {
	throw new Error("Reception account missing");
}
const authentication = { identityId: reception.id, roles: [UserRole.reception] };
const pool = new Pool({ connectionString: process.env.API_DATABASE_URL });
const setup = new Client({ connectionString: process.env.DATABASE_URL });
const output = new URL("../../../performance/indexes/", import.meta.url);
const warmupRuns = 3;
const measuredRuns = 10;

const measureQuery = async (
	transaction: TransactionClient, { scenario, name, sql, parameters }: EvaluationQuery, configuration: string,
) => {

	const plans = [];
	const samples = [];
	for(let run = 0; run < warmupRuns+measuredRuns; run++) {

		const { rows } = await transaction.query<{ "QUERY PLAN": ExecutionPlan[] }>(
			`EXPLAIN (ANALYZE, BUFFERS, SETTINGS, TIMING OFF, FORMAT JSON) ${sql}`, parameters,
		);
		if(run < warmupRuns) {
			continue;
		}
		const plan = rows[0]["QUERY PLAN"][0];
		samples.push([scenario, name, configuration, run-warmupRuns+1, plan["Execution Time"]].join(","));
		if(run === warmupRuns) {
			plans.push({ scenario, query: name, configuration, sql, parameters, plan });
		}

	}

	return { plans, samples };

};

try {

	await setup.connect();
	const evaluations = [];
	for(const scenario of ["professional", "service"]) {

		const evaluation = await runAuthorizedTransaction(authentication, { name: "readDefinitiveAvailability" }, async (transaction, actor) => {

			const { clinicId } = actor;
			const { rows: [service] } = await transaction.query<Pick<Service, "serviceId">>(
				`SELECT service_id AS "serviceId" FROM public.services
				 WHERE clinic_id = $1::uuid AND duration_minutes = 30 ORDER BY service_id LIMIT 1`,
				[clinicId],
			);
			const { serviceId } = service;
			const { rows: [metadata] } = await transaction.query<Pick<Clinic, "timeZone"> & Pick<Service, "specialtyId" | "durationMinutes">>(
				availabilityMetadataQuery, [clinicId, serviceId],
			);
			const { rows: professionals } = await transaction.query<Pick<Professional, "professionalId">>(
				availabilityProfessionalsQuery, [clinicId, serviceId, metadata.specialtyId, null],
			);
			const professionalId = scenario === "professional" ? professionals[0].professionalId : null;
			const professionalIds = professionalId ? [professionalId] : professionals.map(({ professionalId }) => professionalId);
			const { rows: [{ date }] } = await transaction.query<{ date: string }>(
				`SELECT (date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE $1)+INTERVAL '14 days')::date::text AS date`,
				[metadata.timeZone],
			);
			const to = new Date(Date.parse(date)+(scenario === "service" ? 6 : 0)*86_400_000).toISOString().slice(0, 10);
			const calendar = prepareAvailabilityCalendar(date, to, metadata.timeZone);
			const windows = professionalIds.flatMap((professionalId) => {
				return getOccupationWindows(calendar, metadata.durationMinutes).map((window) => ({ professionalId, ...window }));
			});
			const queries = [
				{ name: "metadata", sql: availabilityMetadataQuery, parameters: [clinicId, serviceId] },
				{ name: "professionals", sql: availabilityProfessionalsQuery, parameters: [clinicId, serviceId, metadata.specialtyId, professionalId] },
				{ name: "schedules", sql: availabilitySchedulesQuery, parameters: [clinicId, professionalIds] },
				{ name: "occupation", sql: availabilityOccupationQuery, parameters: [clinicId, professionalIds, JSON.stringify(windows)] },
			];
			const plans = [];
			const samples = [];
			for(const { name, sql, parameters } of queries) {

				if(name === "metadata" && scenario === "service") {
					continue;
				}
				const queryScenario = name === "metadata" ? "clinic-service" : scenario;
				const result = await measureQuery(transaction, { scenario: queryScenario, name, sql, parameters }, "existing-indexes");
				plans.push(...result.plans);
				samples.push(...result.samples);

			}

			return { plans, samples };

		}, pool);
		evaluations.push(evaluation);

	}
	const occupationQueries = evaluations.flatMap(({ plans }) => plans).filter(({ query }) => query === "occupation");
	const indexes = [
		{ configuration: "appointments-end", name: "appointments_reserved_end_idx", columns: "clinic_id, professional_id, end_at" },
		{ configuration: "appointments-start", name: "appointments_reserved_start_idx", columns: "clinic_id, professional_id, start_at" },
		{ configuration: "appointments-professional", name: "appointments_reserved_idx", columns: "clinic_id, professional_id" },
	];
	for(const { configuration, name, columns } of indexes) {

		await setup.query(
			`CREATE INDEX ${name}
			 ON public.appointments (${columns})
			 WHERE state = 'reserved'`,
		);
		const { rows: [{ indexSizeBytes }] } = await setup.query<{ indexSizeBytes: number }>(
			`SELECT pg_relation_size($1::regclass)::integer AS "indexSizeBytes"`, [`public.${name}`],
		);
		for(const { scenario, query, sql, parameters } of occupationQueries) {

			const { plans, samples } = await runAuthorizedTransaction(authentication, { name: "readDefinitiveAvailability" }, async (transaction) => {
				return measureQuery(transaction, { scenario, name: query, sql, parameters }, configuration);
			}, pool);
			evaluations.push({ plans: plans.map((plan) => ({ ...plan, indexSizeBytes })), samples });

		}
		await setup.query(`DROP INDEX public.${name}`);

	}
	writeFileSync(new URL("plans.json", output), JSON.stringify(evaluations.flatMap(({ plans }) => plans), null, 2)+"\n");
	writeFileSync(new URL("samples.csv", output), [
		"scenario,query,configuration,run,executionMs", ...evaluations.flatMap(({ samples }) => samples),
	].join("\n")+"\n");
	console.log("Queries measured");

} finally {
	await setup.end();
	await pool.end();
}
