import { app, router } from "./app.js";
import { createAccessTokenVerifier, createLogoutIdTokenVerifier } from "./clients/keycloak-tokens.js";
import "./config/database-timeouts.js";
import "./config/redis-timeouts.js";
import { UserRole } from "./generated/prisma/enums.js";
import { createAuthentication, requireRoles } from "./middleware/authentication.js";
import { readAppointmentCountsHandler, readClinicAgendaHandler, readOwnAgendaHandler, readPatientAppointmentsHandler, readProfessionalAgendaHandler } from "./routes/appointment-queries.js";
import { cancelAppointmentHandler, createAppointmentHandler, recordAppointmentOutcomeHandler, rescheduleAppointmentHandler } from "./routes/appointments.js";
import { readAuditRecordsHandler } from "./routes/audit-records.js";
import { readProfessionalAvailabilityHandler, readServiceAvailabilityHandler } from "./routes/availability.js";
import { readBlocksHandler, createBlockHandler } from "./routes/blocks.js";
import { readClinicalNoteHandler, createClinicalNoteHandler } from "./routes/clinical-notes.js";
import { createClinicHandler } from "./routes/clinics.js";
import { createLogoutHandler } from "./routes/logout.js";
import { updatePatientHandler, readPatientHandler, createPatientHandler } from "./routes/patients.js";
import { updateProfessionalHandler, createProfessionalHandler } from "./routes/professionals.js";
import { updateProfessionalServiceHandler, createProfessionalServiceHandler } from "./routes/professional-services.js";
import { updateServiceHandler, createServiceHandler } from "./routes/services.js";
import { readWeeklyScheduleHandler, replaceWeeklyScheduleHandler } from "./routes/schedules.js";
import { createSpecialtyHandler } from "./routes/specialties.js";
import { createUserHandler, updateUserHandler } from "./routes/users.js";

const host = process.env.HOST;
const port = Number(process.env.PORT);
const issuer = process.env.KEYCLOAK_ISSUER;
const jwksUrl = process.env.KEYCLOAK_JWKS_URL;
const audience = process.env.KEYCLOAK_AUDIENCE;
const internalUrl = process.env.KEYCLOAK_INTERNAL_URL;
const clientId = process.env.KEYCLOAK_CLIENT_ID;
const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET;

if(!issuer || !jwksUrl || !audience) {
	throw new Error("KEYCLOAK_ISSUER, KEYCLOAK_JWKS_URL, and KEYCLOAK_AUDIENCE are required");
}
if(!internalUrl || !clientId || !clientSecret) {
	throw new Error("KEYCLOAK_INTERNAL_URL, KEYCLOAK_CLIENT_ID, and KEYCLOAK_CLIENT_SECRET are required");
}

const tokenSettings = { issuer, jwksUrl, audience };
const authenticate = createAuthentication(createAccessTokenVerifier(tokenSettings));
const requireAvailabilityRole = requireRoles(UserRole.clinicAdministrator, UserRole.reception, UserRole.healthcareProfessional);
const prepareLogout = createLogoutHandler(createLogoutIdTokenVerifier(tokenSettings), issuer);
const keycloakAdminSettings = {
	issuer: new URL(issuer),
	internalUrl: new URL(internalUrl),
	clientId,
	clientSecret,
};
const createClinic = createClinicHandler(keycloakAdminSettings);
const createUser = createUserHandler(keycloakAdminSettings);
const updateUser = updateUserHandler(keycloakAdminSettings);

router.post("/auth/logout-request", authenticate, prepareLogout);
router.get("/audit-records", authenticate, requireRoles(UserRole.clinicAdministrator), readAuditRecordsHandler);
router.post("/clinics", authenticate, requireRoles(UserRole.platformAdministrator), createClinic);
router.post("/users", authenticate, requireRoles(UserRole.clinicAdministrator), createUser);
router.patch("/users/:userId", authenticate, requireRoles(UserRole.clinicAdministrator), updateUser);
router.post("/specialties", authenticate, requireRoles(UserRole.clinicAdministrator), createSpecialtyHandler);
router.post("/services", authenticate, requireRoles(UserRole.clinicAdministrator), createServiceHandler);
router.patch("/services/:serviceId", authenticate, requireRoles(UserRole.clinicAdministrator), updateServiceHandler);
router.get("/services/:serviceId/availability", authenticate, requireAvailabilityRole, readServiceAvailabilityHandler);
router.post("/patients", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.reception), createPatientHandler);
router.patch("/patients/:patientId", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.reception), updatePatientHandler);
router.get("/patients/:patientId", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.reception, UserRole.healthcareProfessional), readPatientHandler);
router.get("/patients/:patientId/appointments", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.reception, UserRole.healthcareProfessional), readPatientAppointmentsHandler);
router.get("/appointments/agenda", authenticate, requireRoles(UserRole.reception), readClinicAgendaHandler);
router.post("/appointments", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.reception), createAppointmentHandler);
router.post("/appointments/:appointmentId/reschedule", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.reception), rescheduleAppointmentHandler);
router.post("/appointments/:appointmentId/cancel", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.reception), cancelAppointmentHandler);
router.post("/appointments/:appointmentId/outcome", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.reception, UserRole.healthcareProfessional), recordAppointmentOutcomeHandler);
router.get("/appointments/counts", authenticate, requireRoles(UserRole.clinicAdministrator), readAppointmentCountsHandler);
router.get("/professionals/me/agenda", authenticate, requireRoles(UserRole.healthcareProfessional), readOwnAgendaHandler);
router.get("/professionals/:professionalId/agenda", authenticate, requireRoles(UserRole.reception), readProfessionalAgendaHandler);
router.post("/appointments/:appointmentId/clinical-note", authenticate, requireRoles(UserRole.healthcareProfessional), createClinicalNoteHandler);
router.get("/appointments/:appointmentId/clinical-note", authenticate, requireRoles(UserRole.healthcareProfessional), readClinicalNoteHandler);
router.post("/professionals", authenticate, requireRoles(UserRole.clinicAdministrator), createProfessionalHandler);
router.get("/professionals/:professionalId/availability", authenticate, requireAvailabilityRole, readProfessionalAvailabilityHandler);
router.get("/professionals/:professionalId/schedules", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.reception, UserRole.healthcareProfessional), readWeeklyScheduleHandler);
router.get("/professionals/:professionalId/blocks", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.reception, UserRole.healthcareProfessional), readBlocksHandler);
router.post("/professionals/:professionalId/blocks", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.healthcareProfessional), createBlockHandler);
router.put("/professionals/:professionalId/schedules", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.healthcareProfessional), replaceWeeklyScheduleHandler);
router.patch("/professionals/:professionalId", authenticate, requireRoles(UserRole.clinicAdministrator), updateProfessionalHandler);
router.post("/professionals/:professionalId/services", authenticate, requireRoles(UserRole.clinicAdministrator), createProfessionalServiceHandler);
router.patch(
	"/professionals/:professionalId/services/:serviceId",
	authenticate,
	requireRoles(UserRole.clinicAdministrator),
	updateProfessionalServiceHandler,
);

app.listen({ port, host }, (error) => {

	if(error) {
		console.error(error.message);
		process.exitCode = 1;

		return;
	}

	console.info(`API listening on ${host}:${port}`);

});
