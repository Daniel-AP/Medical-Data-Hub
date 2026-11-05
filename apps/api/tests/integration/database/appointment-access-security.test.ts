import { randomUUID } from "node:crypto";
import { Client, escapeIdentifier } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Appointment, Professional, User } from "../../../src/generated/prisma/client.js";

type LocalUser = Pick<User, "userId" | "clinicId"> & { role: string };

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if (!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const api = new Client({ connectionString: apiConnectionString });
const profileNames = ["clinic_administrator", "reception", "healthcare_professional"];
const writerProfiles = ["clinic_administrator", "reception"];
const invalidContexts = [
	{ field: "app.user_id", value: "", label: "an empty actor", malformed: false },
	{ field: "app.clinic_id", value: "", label: "an empty clinic", malformed: false },
	{ field: "app.user_id", value: null, label: "a reset actor", malformed: false },
	{ field: "app.clinic_id", value: null, label: "a reset clinic", malformed: false },
	{ field: "app.user_id", value: "not-a-uuid", label: "a malformed actor", malformed: true },
	{ field: "app.clinic_id", value: "not-a-uuid", label: "a malformed clinic", malformed: true },
];
const insertQuery = `INSERT INTO public.appointments (clinic_id, patient_id, professional_id, service_id, start_at, end_at)
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::timestamptz)`;
const replacementQuery = `INSERT INTO public.appointments (clinic_id, patient_id, professional_id, service_id, start_at, end_at, previous_appointment_id)
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::timestamptz, $7::uuid)`;
let users: LocalUser[];
let administrator: LocalUser;
let appointments: Appointment[];
let target: Appointment;
let foreignAppointment: Appointment;
let foreignUserId: string;
let unassociatedServiceId: string;
let startAt: Date;
let endAt: Date;
let appointmentValues: (string | Date)[];

beforeAll(async () => {
	await setup.connect();
	await api.connect();
	const userResult = await setup.query<LocalUser>(`
        SELECT user_id AS "userId", clinic_id AS "clinicId", role::text
        FROM public.users ORDER BY clinic_id NULLS LAST, user_id
    `);
	users = userResult.rows;
	administrator = users.find((user) => user.role === "clinic_administrator")!;
	const professionalActor = users.find(
		(user) => user.role === "healthcare_professional" && user.clinicId === administrator.clinicId,
	)!;
	const professional = await setup.query<Pick<Professional, "professionalId">>(
		'SELECT professional_id AS "professionalId" FROM public.professionals WHERE user_id = $1::uuid',
		[professionalActor.userId],
	);
	const appointmentResult = await setup.query<Appointment>(`
        SELECT appointment_id AS "appointmentId", clinic_id AS "clinicId", patient_id AS "patientId",
            professional_id AS "professionalId", service_id AS "serviceId", start_at AS "startAt", end_at AS "endAt", state,
            previous_appointment_id AS "previousAppointmentId", cancelled_by_user_id AS "cancelledByUserId", cancellation_reason AS "cancellationReason"
        FROM public.appointments ORDER BY appointment_id
    `);
	appointments = appointmentResult.rows;
	target = appointments.find(
		(appointment) =>
			appointment.professionalId === professional.rows[0].professionalId && appointment.state === "reserved",
	)!;
	foreignAppointment = appointments.find((appointment) => appointment.clinicId !== administrator.clinicId)!;
	foreignUserId = users.find((user) => user.clinicId === foreignAppointment.clinicId)!.userId;
	const service = await setup.query(
		`SELECT service.service_id FROM public.services AS service
        WHERE service.clinic_id = $1::uuid AND NOT EXISTS (
            SELECT 1 FROM public.professional_services AS association
            WHERE association.clinic_id = $1::uuid AND association.professional_id = $2::uuid AND association.service_id = service.service_id
        ) ORDER BY service.service_id LIMIT 1`,
		[target.clinicId, target.professionalId],
	);
	unassociatedServiceId = service.rows[0].service_id;
	startAt = new Date("2030-01-07T15:00:00.000Z");
	endAt = new Date(startAt.getTime() + (target.endAt.getTime() - target.startAt.getTime()));
	appointmentValues = [target.clinicId, target.patientId, target.professionalId, target.serviceId, startAt, endAt];
});

beforeEach(async () => {
	await api.query("BEGIN");
	await api.query(
		`SELECT pg_catalog.set_config('app.user_id', $1, true),
            pg_catalog.set_config('app.clinic_id', $2, true)`,
		[administrator.userId, administrator.clinicId],
	);
	await api.query("SET LOCAL ROLE clinic_administrator");
});

afterEach(async () => {
	await api.query("ROLLBACK");
});

afterAll(async () => {
	await api.end();
	await setup.end();
});

it.each(profileNames)("reads only same-clinic appointment records as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const { rows } = await api.query(`
        SELECT appointment_id AS "appointmentId", clinic_id AS "clinicId", patient_id AS "patientId",
            professional_id AS "professionalId", service_id AS "serviceId", start_at AS "startAt", end_at AS "endAt", state,
            previous_appointment_id AS "previousAppointmentId", cancelled_by_user_id AS "cancelledByUserId", cancellation_reason AS "cancellationReason"
        FROM public.appointments ORDER BY appointment_id
    `);
	expect(rows).toEqual(appointments.filter((appointment) => appointment.clinicId === actor.clinicId));
});

it.each(profileNames)("filters another clinic's appointment identifier as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	expect(
		(
			await api.query("SELECT * FROM public.appointments WHERE appointment_id = $1::uuid", [
				foreignAppointment.appointmentId,
			])
		).rows,
	).toEqual([]);
});

it.each(writerProfiles)("allows appointment insertion and the three editable fields as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const inserted = await api.query(insertQuery + " RETURNING *", appointmentValues);
	expect(inserted.rows).toEqual([
		{
			appointment_id: expect.any(String),
			clinic_id: target.clinicId,
			patient_id: target.patientId,
			professional_id: target.professionalId,
			service_id: target.serviceId,
			start_at: startAt,
			end_at: endAt,
			state: "reserved",
			previous_appointment_id: null,
			cancelled_by_user_id: null,
			cancellation_reason: null,
		},
	]);
	const updated = await api.query(
		`UPDATE public.appointments SET state = 'cancelled', cancelled_by_user_id = $2::uuid, cancellation_reason = $3
        WHERE appointment_id = $1::uuid RETURNING *`,
		[inserted.rows[0].appointment_id, actor.userId, "Synthetic cancellation"],
	);
	expect(updated.rows).toEqual([
		{
			...inserted.rows[0],
			state: "cancelled",
			cancelled_by_user_id: actor.userId,
			cancellation_reason: "Synthetic cancellation",
		},
	]);
});

it.each(["attended", "absent"])("allows healthcare professionals to update state to %s", async (state) => {
	const pastStart = new Date("2020-01-06T15:00:00.000Z");
	const pastEnd = new Date(pastStart.getTime() + (endAt.getTime() - startAt.getTime()));
	const inserted = await api.query(insertQuery + " RETURNING *", [
		target.clinicId,
		target.patientId,
		target.professionalId,
		target.serviceId,
		pastStart,
		pastEnd,
	]);
	const actor = users.find(
		(user) => user.role === "healthcare_professional" && user.clinicId === administrator.clinicId,
	)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query("SET LOCAL ROLE healthcare_professional");
	const updated = await api.query(
		"UPDATE public.appointments SET state = $2::public.appointment_state WHERE appointment_id = $1::uuid RETURNING *",
		[inserted.rows[0].appointment_id, state],
	);
	expect(updated.rows).toEqual([{ ...inserted.rows[0], state }]);
});

it.each(profileNames)("allows direct appointment row locking as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const { rows } = await api.query(
		"SELECT appointment_id FROM public.appointments WHERE appointment_id = $1::uuid FOR NO KEY UPDATE",
		[target.appointmentId],
	);
	expect(rows).toEqual([{ appointment_id: target.appointmentId }]);
});

const immutableColumns = [
	"appointment_id",
	"clinic_id",
	"patient_id",
	"professional_id",
	"service_id",
	"start_at",
	"end_at",
	"previous_appointment_id",
];

it.each(profileNames.flatMap((profileName) => immutableColumns.map((columnName) => ({ profileName, columnName }))))(
	"denies appointments.$columnName updates to $profileName",
	async ({ profileName, columnName }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const column = escapeIdentifier(columnName);
		await expect(
			api.query(`UPDATE public.appointments SET ${column} = ${column} WHERE appointment_id = $1::uuid`, [
				target.appointmentId,
			]),
		).rejects.toMatchObject({ code: "42501" });
	},
);

it.each(["cancelled_by_user_id", "cancellation_reason"])(
	"denies appointments.%s updates to healthcare professionals",
	async (columnName) => {
		const actor = users.find(
			(user) => user.role === "healthcare_professional" && user.clinicId === administrator.clinicId,
		)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query("SET LOCAL ROLE healthcare_professional");
		const column = escapeIdentifier(columnName);
		await expect(
			api.query(`UPDATE public.appointments SET ${column} = ${column} WHERE appointment_id = $1::uuid`, [
				target.appointmentId,
			]),
		).rejects.toMatchObject({ code: "42501" });
	},
);

it("denies appointment insertion to healthcare professionals", async () => {
	const actor = users.find(
		(user) => user.role === "healthcare_professional" && user.clinicId === administrator.clinicId,
	)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query("SET LOCAL ROLE healthcare_professional");
	await expect(api.query(insertQuery, appointmentValues)).rejects.toMatchObject({ code: "42501" });
});

it.each(writerProfiles)("rejects foreign-clinic appointment inserts through RLS as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	await expect(
		api.query(insertQuery, [
			foreignAppointment.clinicId,
			foreignAppointment.patientId,
			foreignAppointment.professionalId,
			foreignAppointment.serviceId,
			startAt,
			endAt,
		]),
	).rejects.toMatchObject({
		code: "42501",
		message: 'new row violates row-level security policy for table "appointments"',
	});
});

it.each(profileNames)("filters foreign appointment state updates as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const result = await api.query("UPDATE public.appointments SET state = state WHERE appointment_id = $1::uuid", [
		foreignAppointment.appointmentId,
	]);
	expect(result.rowCount).toBe(0);
});

const foreignReferences = [
	{ resource: "patient", constraint: "appointments_clinic_id_patient_id_fkey" },
	{ resource: "professional", constraint: "appointments_clinic_id_professional_id_fkey" },
	{ resource: "service", constraint: "appointments_clinic_id_service_id_fkey" },
	{ resource: "previous appointment", constraint: "appointments_clinic_id_previous_appointment_id_patient_id__fkey" },
];

it.each(writerProfiles.flatMap((profileName) => foreignReferences.map((reference) => ({ profileName, ...reference }))))(
	"rejects foreign-clinic $resource references during appointment insertion as $profileName",
	async ({ profileName, resource, constraint }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const patientId = resource === "patient" ? foreignAppointment.patientId : target.patientId;
		const professionalId = resource === "professional" ? foreignAppointment.professionalId : target.professionalId;
		const serviceId = resource === "service" ? foreignAppointment.serviceId : target.serviceId;
		const values = [target.clinicId, patientId, professionalId, serviceId, startAt, endAt];
		const query = resource === "previous appointment" ? replacementQuery : insertQuery;
		if (resource === "previous appointment") values.push(foreignAppointment.appointmentId);
		await expect(api.query(query, values)).rejects.toMatchObject({ code: "23503", constraint });
	},
);

it.each(writerProfiles)(
	"rejects appointment inserts without a local professional-service association as %s",
	async (profileName) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		await expect(
			api.query(insertQuery, [
				target.clinicId,
				target.patientId,
				target.professionalId,
				unassociatedServiceId,
				startAt,
				endAt,
			]),
		).rejects.toMatchObject({
			code: "23503",
			constraint: "appointments_clinic_id_professional_id_service_id_fkey",
		});
	},
);

it.each(writerProfiles)("rejects foreign-clinic cancellation users as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	await expect(
		api.query(
			"UPDATE public.appointments SET state = 'cancelled', cancelled_by_user_id = $2::uuid, cancellation_reason = 'Synthetic cancellation' WHERE appointment_id = $1::uuid",
			[target.appointmentId, foreignUserId],
		),
	).rejects.toMatchObject({ code: "23503", constraint: "appointments_clinic_id_cancelled_by_user_id_fkey" });
});

it.each(writerProfiles)("preserves the unique replacement appointment reference as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	const original = await api.query(insertQuery + " RETURNING appointment_id", appointmentValues);
	await api.query("UPDATE public.appointments SET state = 'rescheduled' WHERE appointment_id = $1::uuid", [
		original.rows[0].appointment_id,
	]);
	const values = [
		target.clinicId,
		target.patientId,
		target.professionalId,
		target.serviceId,
		new Date(startAt.getTime() + 86400000),
		new Date(endAt.getTime() + 86400000),
		original.rows[0].appointment_id,
	];
	expect((await api.query(replacementQuery, values)).rowCount).toBe(1);
	await expect(api.query(replacementQuery, values)).rejects.toMatchObject({
		code: "23505",
		constraint: "appointments_previous_key",
	});
});

it.each(writerProfiles)("rejects self-referencing appointment replacements as %s", async (profileName) => {
	const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
	await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
	await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
	await expect(
		api.query(
			`INSERT INTO public.appointments (appointment_id, clinic_id, patient_id, professional_id, service_id, start_at, end_at, previous_appointment_id)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::timestamptz, $7::timestamptz, $1::uuid)`,
			[randomUUID(), ...appointmentValues],
		),
	).rejects.toMatchObject({ code: "23514", constraint: "appointments_previous_check" });
});

const invalidIntervals = [
	{
		label: "reversed intervals",
		start: "2030-01-07 15:30:00+00",
		end: "2030-01-07 15:00:00+00",
		constraint: "appointments_interval_check",
	},
	{
		label: "empty intervals",
		start: "2030-01-07 15:00:00+00",
		end: "2030-01-07 15:00:00+00",
		constraint: "appointments_interval_check",
	},
	{
		label: "non-minute starts",
		start: "2030-01-07 15:00:01+00",
		end: "2030-01-07 15:30:00+00",
		constraint: "appointments_minute_check",
	},
	{
		label: "nonfinite starts",
		start: "-infinity",
		end: "2030-01-07 15:30:00+00",
		constraint: "appointments_minute_check",
	},
];

it.each(writerProfiles.flatMap((profileName) => invalidIntervals.map((interval) => ({ profileName, ...interval }))))(
	"rejects $label during appointment insertion as $profileName",
	async ({ profileName, start, end, constraint }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		await expect(
			api.query(insertQuery, [
				target.clinicId,
				target.patientId,
				target.professionalId,
				target.serviceId,
				start,
				end,
			]),
		).rejects.toMatchObject({ code: "23514", constraint });
	},
);

const invalidCancellations = [
	{ label: "missing cancellation users", state: "cancelled", needsUser: false, reason: "Synthetic cancellation" },
	{ label: "missing cancellation reasons", state: "cancelled", needsUser: true, reason: null },
	{ label: "empty cancellation reasons", state: "cancelled", needsUser: true, reason: "" },
	{
		label: "cancellation fields on other states",
		state: "attended",
		needsUser: true,
		reason: "Synthetic cancellation",
	},
];

it.each(
	writerProfiles.flatMap((profileName) =>
		["INSERT", "UPDATE"].flatMap((operation) =>
			invalidCancellations.map((cancellation) => ({ profileName, operation, ...cancellation })),
		),
	),
)(
	"rejects $label during appointment $operation as $profileName",
	async ({ profileName, operation, state, needsUser, reason }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const cancelledByUserId = needsUser ? actor.userId : null;
		const query =
			operation === "INSERT"
				? `INSERT INTO public.appointments (clinic_id, patient_id, professional_id, service_id, start_at, end_at, state, cancelled_by_user_id, cancellation_reason)
                VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6::timestamptz, $7::public.appointment_state, $8::uuid, $9)`
				: "UPDATE public.appointments SET state = $2::public.appointment_state, cancelled_by_user_id = $3::uuid, cancellation_reason = $4 WHERE appointment_id = $1::uuid";
		const values =
			operation === "INSERT"
				? [...appointmentValues, state, cancelledByUserId, reason]
				: [target.appointmentId, state, cancelledByUserId, reason];
		await expect(api.query(query, values)).rejects.toMatchObject({
			code: "23514",
			constraint: "appointments_cancellation_check",
		});
	},
);

it.each(profileNames.flatMap((profileName) => ["DELETE", "TRUNCATE"].map((operation) => ({ profileName, operation }))))(
	"denies appointment $operation to $profileName",
	async ({ profileName, operation }) => {
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const query =
			operation === "DELETE"
				? "DELETE FROM public.appointments WHERE appointment_id = $1::uuid"
				: "TRUNCATE public.appointments";
		await expect(api.query(query, operation === "DELETE" ? [target.appointmentId] : [])).rejects.toMatchObject({
			code: "42501",
		});
	},
);

it.each([
	"medical_data_hub_api",
	"platform_administrator",
	"medical_data_hub_identity_owner",
	"medical_data_hub_metadata_owner",
	"medical_data_hub_locking_owner",
])("denies full appointment reads to %s despite supplied context", async (profileName) => {
	await setup.query("BEGIN");
	try {
		await setup.query(
			`SELECT pg_catalog.set_config('app.user_id', $1, true),
                    pg_catalog.set_config('app.clinic_id', $2, true)`,
			[administrator.userId, administrator.clinicId],
		);
		await setup.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		await expect(setup.query("SELECT * FROM public.appointments")).rejects.toMatchObject({ code: "42501" });
	} finally {
		await setup.query("ROLLBACK");
	}
});

it("preserves identifier-only appointment reads by the metadata owner without ordinary context", async () => {
	await setup.query("BEGIN");
	try {
		await setup.query("SET LOCAL ROLE medical_data_hub_metadata_owner");
		const { rows } = await setup.query(`
            SELECT appointment_id AS "appointmentId", clinic_id AS "clinicId", professional_id AS "professionalId",
                patient_id AS "patientId", service_id AS "serviceId" FROM public.appointments ORDER BY appointment_id
        `);
		expect(rows).toEqual(
			appointments.map(({ appointmentId, clinicId, professionalId, patientId, serviceId }) => ({
				appointmentId,
				clinicId,
				professionalId,
				patientId,
				serviceId,
			})),
		);
		await expect(setup.query("SELECT state FROM public.appointments")).rejects.toMatchObject({ code: "42501" });
	} finally {
		await setup.query("ROLLBACK");
	}
});

it.each(profileNames.flatMap((profileName) => invalidContexts.map((context) => ({ profileName, ...context }))))(
	"restricts appointment reads with $label as $profileName",
	async ({ profileName, field, value, malformed }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query("SELECT pg_catalog.set_config($1, $2, true)", [field, value]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const result = api.query("SELECT * FROM public.appointments");
		if (malformed) {
			await expect(result).rejects.toMatchObject({ code: "22P02" });
		} else {
			expect((await result).rows).toEqual([]);
		}
	},
);

it.each(writerProfiles.flatMap((profileName) => invalidContexts.map((context) => ({ profileName, ...context }))))(
	"rejects appointment inserts with $label as $profileName",
	async ({ profileName, field, value, malformed }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query("SELECT pg_catalog.set_config($1, $2, true)", [field, value]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const expected = malformed
			? { code: "22P02" }
			: { code: "42501", message: 'new row violates row-level security policy for table "appointments"' };
		await expect(api.query(insertQuery, appointmentValues)).rejects.toMatchObject(expected);
	},
);

it.each(profileNames.flatMap((profileName) => invalidContexts.map((context) => ({ profileName, ...context }))))(
	"restricts appointment updates with $label as $profileName",
	async ({ profileName, field, value, malformed }) => {
		const actor = users.find((user) => user.role === profileName && user.clinicId === administrator.clinicId)!;
		await api.query("SELECT pg_catalog.set_config('app.user_id', $1, true)", [actor.userId]);
		await api.query("SELECT pg_catalog.set_config($1, $2, true)", [field, value]);
		await api.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		const result = api.query("UPDATE public.appointments SET state = state WHERE appointment_id = $1::uuid", [
			target.appointmentId,
		]);
		if (malformed) {
			await expect(result).rejects.toMatchObject({ code: "22P02" });
		} else {
			expect((await result).rowCount).toBe(0);
		}
	},
);

it.each(profileNames)("denies appointment access without context as %s", async (profileName) => {
	const fresh = new Client({ connectionString: apiConnectionString });
	await fresh.connect();
	try {
		await fresh.query("BEGIN");
		await fresh.query(`SET LOCAL ROLE ${escapeIdentifier(profileName)}`);
		expect((await fresh.query("SELECT * FROM public.appointments")).rows).toEqual([]);
		expect(
			(
				await fresh.query("UPDATE public.appointments SET state = state WHERE appointment_id = $1::uuid", [
					target.appointmentId,
				])
			).rowCount,
		).toBe(0);
		if (profileName !== "healthcare_professional") {
			await expect(fresh.query(insertQuery, appointmentValues)).rejects.toMatchObject({
				code: "42501",
				message: 'new row violates row-level security policy for table "appointments"',
			});
		}
	} finally {
		await fresh.query("ROLLBACK");
		await fresh.end();
	}
});

it("grants only the designed appointment table and column privileges", async () => {
	const roles = [
		"medical_data_hub_api",
		"platform_administrator",
		...profileNames,
		"medical_data_hub_identity_owner",
		"medical_data_hub_metadata_owner",
		"medical_data_hub_locking_owner",
	];
	const tableGrants = await setup.query(
		`SELECT grantee, privilege_type, is_grantable FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = 'appointments' AND grantee = ANY($1::text[])
        ORDER BY grantee, privilege_type`,
		[roles],
	);
	expect(tableGrants.rows).toEqual([
		{ grantee: "clinic_administrator", privilege_type: "INSERT", is_grantable: "NO" },
		{ grantee: "clinic_administrator", privilege_type: "SELECT", is_grantable: "NO" },
		{ grantee: "healthcare_professional", privilege_type: "SELECT", is_grantable: "NO" },
		{ grantee: "reception", privilege_type: "INSERT", is_grantable: "NO" },
		{ grantee: "reception", privilege_type: "SELECT", is_grantable: "NO" },
	]);
	const updateGrants = await setup.query(
		`SELECT grantee, column_name, is_grantable FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'appointments' AND grantee = ANY($1::text[]) AND privilege_type = 'UPDATE'
        ORDER BY grantee, column_name`,
		[roles],
	);
	expect(updateGrants.rows).toEqual([
		...["cancellation_reason", "cancelled_by_user_id", "state"].map((columnName) => ({
			grantee: "clinic_administrator",
			column_name: columnName,
			is_grantable: "NO",
		})),
		{ grantee: "healthcare_professional", column_name: "state", is_grantable: "NO" },
		...["cancellation_reason", "cancelled_by_user_id", "state"].map((columnName) => ({
			grantee: "reception",
			column_name: columnName,
			is_grantable: "NO",
		})),
	]);
	const metadataGrants = await setup.query(`
        SELECT column_name, privilege_type, is_grantable FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'appointments' AND grantee = 'medical_data_hub_metadata_owner'
        ORDER BY column_name, privilege_type
    `);
	expect(metadataGrants.rows).toEqual(
		["appointment_id", "clinic_id", "patient_id", "professional_id", "service_id"].map((columnName) => ({
			column_name: columnName,
			privilege_type: "SELECT",
			is_grantable: "NO",
		})),
	);
});
