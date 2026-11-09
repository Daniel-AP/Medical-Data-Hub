import { readFileSync } from "node:fs";
import { AppointmentState, AuditAction, AuditResource, UserRole } from "../src/generated/prisma/client.js";
import { prisma } from "../src/database/client.js";

const realm = JSON.parse(
	readFileSync(new URL("../../../infra/keycloak/development/medical-data-hub-realm.json", import.meta.url), "utf8"),
) as { users: { id?: string; username: string }[] };

const localDate = new Intl.DateTimeFormat("en-CA", {
	timeZone: "America/Costa_Rica",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
}).format(new Date());
const weekStartAt = new Date(`${localDate}T00:00:00-06:00`);
weekStartAt.setUTCDate(weekStartAt.getUTCDate() - ((weekStartAt.getUTCDay() + 6) % 7));

const dateAt = (weekOffset: number, weekday: number, minute: number) => {
	return new Date(weekStartAt.getTime() + ((weekOffset * 7 + weekday - 1) * 1440 + minute) * 60_000);
};

const numberedUsername = (username: string, number: number) => {
	return number === 1 ? username : `${username}-${number}`;
};

const clinicNames = ["Clínica Central", "Clínica Norte", "Clínica Sur"];
const patientNames = ["Ana Solano", "Luis Mora", "Sofía Vega", "Diego Rojas", "Carla Ruiz", "Pablo León"];
const scheduleIntervals = [
	{ startMinute: 480, endMinute: 720 },
	{ startMinute: 780, endMinute: 1020 },
];
const appointmentFixtures = [
	{ startAt: dateAt(-1, 1, 540), state: AppointmentState.attended },
	{ startAt: dateAt(-1, 2, 600), state: AppointmentState.absent },
	{ startAt: dateAt(1, 1, 540), state: AppointmentState.reserved },
	{ startAt: dateAt(1, 2, 660), state: AppointmentState.cancelled },
	{ startAt: dateAt(1, 3, 540), state: AppointmentState.rescheduled },
];

try {
	const inserted = await prisma.$transaction(async (tx) => {
		const existingClinic = await tx.clinic.findFirst({ select: { clinicId: true } });
		const existingUser = await tx.user.findFirst({ select: { userId: true } });
		if (existingClinic || existingUser) {
			return false;
		}

		const createUser = async (username: string, role: UserRole, clinicId: string | null) => {
			const identity = realm.users.find((user) => user.username === username);
			if (!identity?.id) {
				throw new Error(`Missing seed identity: ${username}`);
			}

			return tx.user.create({ data: { identityId: identity.id, clinicId, role } });
		};

		await createUser("platform-administrator", UserRole.platformAdministrator, null);

		for (const [clinicIndex, name] of clinicNames.entries()) {
			const { clinicId } = await tx.clinic.create({ data: { name, timeZone: "America/Costa_Rica" } });
			await tx.clinicAvailabilityVersion.create({ data: { clinicId } });
			await createUser(
				numberedUsername("clinic-administrator", clinicIndex + 1),
				UserRole.clinicAdministrator,
				clinicId,
			);
			const receptionUser = await createUser(
				numberedUsername("reception", clinicIndex + 1),
				UserRole.reception,
				clinicId,
			);

			const [generalSpecialty, physiotherapySpecialty] = await Promise.all(
				["Medicina general", "Fisioterapia"].map((name) => tx.specialty.create({ data: { clinicId, name } })),
			);
			const [generalService, followUpService, physiotherapyService] = await Promise.all(
				[
					{ name: "Consulta general", specialtyId: generalSpecialty.specialtyId, durationMinutes: 30 },
					{ name: "Consulta de seguimiento", specialtyId: generalSpecialty.specialtyId, durationMinutes: 15 },
					{
						name: "Sesión de fisioterapia",
						specialtyId: physiotherapySpecialty.specialtyId,
						durationMinutes: 45,
					},
				].map((data) => tx.service.create({ data: { clinicId, ...data } })),
			);

			const patientIds: string[] = [];
			for (const [patientIndex, name] of patientNames.entries()) {
				const { patientId } = await tx.patient.create({
					data: {
						clinicId,
						identification: `DEMO-${patientIndex + 1}`,
						name,
						dateOfBirth: new Date(`${1985 + patientIndex}-05-15T00:00:00Z`),
						email: `patient-${clinicIndex + 1}-${patientIndex + 1}@example.test`,
					},
				});
				patientIds.push(patientId);
				await tx.auditRecord.create({
					data: {
						clinicId,
						userId: receptionUser.userId,
						patientId,
						resource: AuditResource.patientContact,
						action: AuditAction.write,
						occurredAt: dateAt(-2, 1, 480),
					},
				});
			}

			for (const [professionalIndex, services] of [
				[generalService, followUpService],
				[generalService, followUpService],
				[physiotherapyService],
			].entries()) {
				const professionalUser = await createUser(
					numberedUsername("healthcare-professional", clinicIndex * 3 + professionalIndex + 1),
					UserRole.healthcareProfessional,
					clinicId,
				);
				const { professionalId } = await tx.professional.create({
					data: { clinicId, userId: professionalUser.userId, specialtyId: services[0].specialtyId },
				});
				await tx.professionalService.createMany({
					data: services.map(({ serviceId }) => ({ clinicId, professionalId, serviceId })),
				});
				await tx.professionalSchedule.createMany({
					data: [1, 2, 3, 4, 5].flatMap((weekday) =>
						scheduleIntervals.map((interval) => ({ clinicId, professionalId, weekday, ...interval })),
					),
				});
				await tx.professionalBlock.create({
					data: { clinicId, professionalId, startAt: dateAt(1, 5, 840), endAt: dateAt(1, 5, 900) },
				});

				for (const [appointmentIndex, { startAt, state }] of appointmentFixtures.entries()) {
					const { serviceId, durationMinutes } = services[appointmentIndex % services.length];
					const patientId = patientIds[professionalIndex * 2 + (appointmentIndex % 2)];
					const durationMs = durationMinutes * 60_000;
					const appointmentData = {
						clinicId,
						professionalId,
						patientId,
						serviceId,
						startAt,
						endAt: new Date(startAt.getTime() + durationMs),
					};
					const isCancelled = state === AppointmentState.cancelled;
					const { appointmentId, endAt } = await tx.appointment.create({
						data: {
							...appointmentData,
							state,
							cancelledByUserId: isCancelled ? receptionUser.userId : null,
							cancellationReason: isCancelled
								? "Cancelación de demostración solicitada por el paciente."
								: null,
						},
					});

					if (state === AppointmentState.attended) {
						await tx.clinicalNote.create({
							data: {
								clinicId,
								appointmentId,
								content:
									"Nota clínica ficticia para demostración. Paciente atendido, sin datos reales.",
							},
						});
						await tx.auditRecord.create({
							data: {
								clinicId,
								patientId,
								userId: professionalUser.userId,
								appointmentId,
								resource: AuditResource.clinicalNote,
								action: AuditAction.write,
								occurredAt: endAt,
							},
						});
					}
					if (state === AppointmentState.rescheduled) {
						const replacementStartAt = dateAt(1, 4, 600);
						await tx.appointment.create({
							data: {
								...appointmentData,
								startAt: replacementStartAt,
								endAt: new Date(replacementStartAt.getTime() + durationMs),
								state: AppointmentState.reserved,
								previousAppointmentId: appointmentId,
							},
						});
					}
				}
			}
		}

		return true;
	});
	console.log(inserted ? "Database seed completed." : "Seed skipped: domain tables already contain data.");
} catch {
	console.error("Database seed failed.");
	process.exitCode = 1;
} finally {
	await prisma.$disconnect();
}
