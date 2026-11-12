import { Client, Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runAuthorizedTransaction } from "../../../src/database/authorization.js";
import type { Appointment, Professional, User } from "../../../src/generated/prisma/client.js";
import { UserRole } from "../../../src/generated/prisma/enums.js";

type SeedActor = Pick<User, "userId" | "identityId"> & { role: string };
type SeedAppointment = Pick<Appointment, "appointmentId" | "clinicId" | "professionalId" | "patientId" | "serviceId">;
type SeedDestination = Pick<Professional, "professionalId" | "userId"> & Pick<User, "clinicId" | "isActive">;

const setupConnectionString = process.env.DATABASE_SETUP_URL;
const apiConnectionString = process.env.DATABASE_URL;
if(!setupConnectionString || !apiConnectionString) {
	throw new Error("DATABASE_SETUP_URL and DATABASE_URL are required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const pool = new Pool({ connectionString: apiConnectionString, max: 1 });
let originalAppointment: SeedAppointment;
let foreignAppointment: SeedAppointment;
let destination: SeedDestination;
let foreignDestination: SeedDestination;
let clinicActors: SeedActor[];

beforeAll(async () => {

	await setup.connect();
	const appointments = await setup.query<SeedAppointment>(`
		SELECT DISTINCT ON (clinic_id) appointment_id AS "appointmentId", clinic_id AS "clinicId",
		       professional_id AS "professionalId", patient_id AS "patientId", service_id AS "serviceId"
		FROM public.appointments WHERE state = 'reserved' ORDER BY clinic_id, appointment_id
	`);
	[originalAppointment, foreignAppointment] = appointments.rows;

	const destinations = await setup.query<SeedDestination>(
		`SELECT DISTINCT ON (professional.clinic_id) professional.professional_id AS "professionalId",
		        professional.user_id AS "userId", professional.clinic_id AS "clinicId", local_user.is_active AS "isActive"
		 FROM public.professionals AS professional
		 JOIN public.users AS local_user ON local_user.user_id = professional.user_id
		 WHERE professional.clinic_id IN ($1::uuid, $2::uuid) AND professional.professional_id <> $3::uuid
		 ORDER BY professional.clinic_id, professional.professional_id`,
		[originalAppointment.clinicId, foreignAppointment.clinicId, originalAppointment.professionalId],
	);
	[destination, foreignDestination] = destinations.rows;

	const actors = await setup.query<SeedActor>(
		`SELECT user_id AS "userId", identity_id AS "identityId", role
		 FROM public.users WHERE clinic_id = $1::uuid AND role IN ('clinic_administrator', 'reception')`,
		[originalAppointment.clinicId],
	);
	clinicActors = actors.rows;

});

afterAll(async () => {
	await pool.end();
	await setup.end();
});

it.each([
	{ databaseRole: "clinic_administrator", role: UserRole.clinicAdministrator },
	{ databaseRole: "reception", role: UserRole.reception },
])(
	"prepares rescheduling with the current local profile $databaseRole and a shared destination user lock",
	async ({ databaseRole, role }) => {

		const actor = clinicActors.find((user) => user.role === databaseRole)!;
		const result = await runAuthorizedTransaction(
			{ identityId: actor.identityId, roles: [UserRole.clinicAdministrator, UserRole.reception] },
			{
				name: "rescheduleAppointment",
				appointmentId: originalAppointment.appointmentId,
				destinationProfessionalId: destination.professionalId,
			},
			async (client, context) => {

				const { rows } = await setup.query(
					"SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR SHARE NOWAIT",
					[destination.userId],
				);
				expect(rows).toEqual([{ user_id: destination.userId }]);
				await expect(
					setup.query("SELECT user_id FROM public.users WHERE user_id = $1::uuid FOR NO KEY UPDATE NOWAIT", [
						destination.userId,
					]),
				).rejects.toMatchObject({ code: "55P03" });

				const { rows: profiles } = await client.query("SELECT current_user AS role");

				return { context, databaseRole: profiles[0].role };

			},
			pool,
		);

		expect(result).toEqual({
			context: {
				userId: actor.userId,
				clinicId: originalAppointment.clinicId,
				role,
				originalAppointment: {
					professionalId: originalAppointment.professionalId,
					patientId: originalAppointment.patientId,
					serviceId: originalAppointment.serviceId,
				},
				destinationUser: {
					userId: destination.userId,
					clinicId: destination.clinicId,
					role: "healthcare_professional",
					isActive: destination.isActive,
				},
			},
			databaseRole,
		});

	},
);

it("rejects rescheduling when the token contains only the other permitted role", async () => {

	const actor = clinicActors.find((user) => user.role === "reception")!;
	const callback = vi.fn();

	await expect(
		runAuthorizedTransaction(
			{ identityId: actor.identityId, roles: [UserRole.clinicAdministrator] },
			{
				name: "rescheduleAppointment",
				appointmentId: originalAppointment.appointmentId,
				destinationProfessionalId: destination.professionalId,
			},
			callback,
			pool,
		),
	).rejects.toMatchObject({ status: 403 });
	expect(callback).not.toHaveBeenCalled();

});

it.each(["original appointment", "destination professional"])(
	"rejects rescheduling with a foreign %s before invoking the callback",
	async (foreignResource) => {

		const actor = clinicActors.find((user) => user.role === "reception")!;
		const appointment = foreignResource === "original appointment" ? foreignAppointment : originalAppointment;
		const professional = foreignResource === "destination professional" ? foreignDestination : destination;
		const callback = vi.fn();

		await expect(
			runAuthorizedTransaction(
				{ identityId: actor.identityId, roles: [UserRole.reception] },
				{
					name: "rescheduleAppointment",
					appointmentId: appointment.appointmentId,
					destinationProfessionalId: professional.professionalId,
				},
				callback,
				pool,
			),
		).rejects.toMatchObject({ status: 404 });
		expect(callback).not.toHaveBeenCalled();

	},
);
