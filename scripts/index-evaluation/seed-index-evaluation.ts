import { randomUUID } from "node:crypto";
import { AppointmentState, UserRole } from "../../apps/api/src/generated/prisma/client.js";
import { prisma } from "../../apps/api/src/database/prisma-client.js";

const localDate = new Intl.DateTimeFormat("en-CA", {
	timeZone: "America/Costa_Rica", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const monday = new Date(`${localDate}T00:00:00-06:00`);
monday.setUTCDate(monday.getUTCDate()-((monday.getUTCDay()+6)%7));

const dateAt = (day: number, minute: number) => new Date(monday.getTime()+(day*1440+minute)*60_000);

const getStarts = (from: number, to: number, durationMinutes: number, count: number) => {

	const starts: Date[] = [];
	const halfDaySlots = Math.floor(240/durationMinutes);
	const minutes = [480, 780].flatMap((start) => {
		return Array.from({ length: halfDaySlots }, (_, slot) => start+slot*durationMinutes);
	});
	for(const minute of minutes) {

		for(let day = from; day <= to; day++) {

			const start = dateAt(day, minute);
			const weekday = start.getUTCDay();
			const isBlocked = weekday === 3 && minute === minutes[minutes.length-1];
			if(weekday === 0 || weekday === 6 || isBlocked) {
				continue;
			}
			starts.push(start);

		}

	}

	return starts.slice(0, count).sort((first, second) => first.getTime()-second.getTime());

};

const pastStates = [
	AppointmentState.attended, AppointmentState.absent, AppointmentState.reserved,
	AppointmentState.rescheduled, AppointmentState.reserved,
	AppointmentState.attended, AppointmentState.attended, AppointmentState.attended,
	AppointmentState.attended, AppointmentState.cancelled,
];
const futureStates = pastStates.map((state) => {
	return state === AppointmentState.attended || state === AppointmentState.absent ? AppointmentState.reserved : state;
});

try {

	const clinics = await prisma.clinic.findMany({ orderBy: { name: "asc" } });
	for(const { clinicId } of clinics) {

		const generalService = await prisma.service.findFirstOrThrow({ where: { clinicId, durationMinutes: 30 } });
		const generalServices = await prisma.service.findMany({ where: { clinicId, specialtyId: generalService.specialtyId } });
		const reception = await prisma.user.findFirstOrThrow({ where: { clinicId, role: UserRole.reception } });
		for(let number = 4; number <= 30; number++) {

			const { userId } = await prisma.user.create({
				data: { clinicId, identityId: `index-evaluation/${clinicId}/${number}`, role: UserRole.healthcareProfessional },
			});
			const { professionalId } = await prisma.professional.create({
				data: { clinicId, userId, specialtyId: generalService.specialtyId },
			});
			await prisma.professionalService.createMany({
				data: generalServices.map(({ serviceId }) => ({ clinicId, professionalId, serviceId })),
			});
			await prisma.professionalSchedule.createMany({
				data: [1, 2, 3, 4, 5].flatMap((weekday) => [
					{ clinicId, professionalId, weekday, startMinute: 480, endMinute: 720 },
					{ clinicId, professionalId, weekday, startMinute: 780, endMinute: 1020 },
				]),
			});

		}

		const profiles = await prisma.professional.findMany({
			where: { clinicId }, orderBy: { professionalId: "asc" },
			include: { professionalServices: { include: { service: true } } },
		});
		const professionals = profiles.map(({ professionalId, professionalServices }) => {

			const [service] = professionalServices.map(({ service }) => service).sort((first, second) => {
				return second.durationMinutes-first.durationMinutes;
			});

			return { professionalId, service };

		});
		let remainingAppointments = 100_000-await prisma.appointment.count({ where: { clinicId } });
		let remainingSlots = professionals.reduce((total, { service }) => total+2*Math.floor(240/service.durationMinutes), 0);
		for(const { professionalId, service } of professionals) {

			const { serviceId, durationMinutes } = service;
			const halfDaySlots = Math.floor(240/durationMinutes);
			const count = Math.floor(remainingAppointments*halfDaySlots*2/remainingSlots);
			remainingAppointments -= count;
			remainingSlots -= halfDaySlots*2;

			const patients = Array.from({ length: 100 }, (_, index) => ({
				patientId: randomUUID(), clinicId, identification: `EVAL-${professionalId}-${index+1}`,
				name: `Evaluation patient ${index+1}`, dateOfBirth: new Date("1990-01-01T00:00:00Z"),
				email: `patient-${index+1}-${professionalId}@example.test`,
			}));
			await prisma.patient.createMany({ data: patients });

			const blocks = [];
			for(let week = -52; week <= 14; week++) {
				blocks.push(
					{ clinicId, professionalId, startAt: dateAt(week*7+5, 0), endAt: dateAt(week*7+7, 480) },
					{ clinicId, professionalId, startAt: dateAt(week*7+2, 780+(halfDaySlots-1)*durationMinutes), endAt: dateAt(week*7+2, 1020) },
				);
			}
			await prisma.professionalBlock.createMany({ data: blocks });

			const pastCount = Math.floor(count*0.8);
			const starts = [...getStarts(-364, -8, durationMinutes, pastCount), ...getStarts(14, 90, durationMinutes, count-pastCount)];
			const appointmentIds = starts.map(() => randomUUID());
			const appointments = starts.map((startAt, index) => {

				const states = index < pastCount ? pastStates : futureStates;
				let state = states[index%states.length];
				if(state === AppointmentState.rescheduled && index === starts.length-1) {
					state = AppointmentState.reserved;
				}
				const isReplacement = index%states.length === 4;
				const isCancelled = state === AppointmentState.cancelled;
				const patientIndex = isReplacement ? index-1 : index;

				return {
					appointmentId: appointmentIds[index], clinicId, professionalId, serviceId,
					patientId: patients[patientIndex%patients.length].patientId,
					startAt, endAt: new Date(startAt.getTime()+durationMinutes*60_000), state,
					previousAppointmentId: isReplacement ? appointmentIds[index-1] : null,
					cancelledByUserId: isCancelled ? reception.userId : null,
					cancellationReason: isCancelled ? "Evaluation cancellation" : null,
				};

			});
			await prisma.appointment.createMany({ data: appointments });

		}

	}
	await prisma.$executeRaw`ANALYZE`;
	console.log("Data loaded");

} finally {
	await prisma.$disconnect();
}
