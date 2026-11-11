import { app, router } from "./app.js";
import { createAccessTokenVerifier, createLogoutIdTokenVerifier } from "./clients/keycloak/token-verification.js";
import "./config/database-timeouts.js";
import "./config/redis-timeouts.js";
import { UserRole } from "./generated/prisma/enums.js";
import { createAuthenticationMiddleware, requireRoles } from "./middleware/authentication.js";
import { getAppointmentCounts, listClinicAgenda, listOwnAgenda, listPatientAppointments, listProfessionalAgenda } from "./routes/appointment-queries.js";
import { listAuditRecords } from "./routes/audit-records.js";
import { getClinicalNote, registerClinicalNote } from "./routes/clinical-notes.js";
import { createClinicRequestHandler } from "./routes/clinics.js";
import { createLogoutRequestHandler } from "./routes/logout.js";
import { editPatient, getPatient, registerPatient } from "./routes/patients.js";
import { editProfessionalSpecialty, registerProfessional } from "./routes/professionals.js";
import { editProfessionalServiceActivity, registerProfessionalService } from "./routes/professional-services.js";
import { editService, registerService } from "./routes/services.js";
import { replaceSchedules } from "./routes/schedules.js";
import { registerSpecialty } from "./routes/specialties.js";
import { createUserRequestHandler, updateUserPermissionsRequestHandler } from "./routes/users.js";

const host = process.env.HOST;
const port = Number(process.env.PORT);
const issuer = process.env.KEYCLOAK_ISSUER;
const jwksUrl = process.env.KEYCLOAK_JWKS_URL;
const audience = process.env.KEYCLOAK_AUDIENCE;
const internalUrl = process.env.KEYCLOAK_INTERNAL_URL;
const applicationId = process.env.KEYCLOAK_CLIENT_ID;
const applicationSecret = process.env.KEYCLOAK_CLIENT_SECRET;

if(!issuer || !jwksUrl || !audience) {
	throw new Error("KEYCLOAK_ISSUER, KEYCLOAK_JWKS_URL, and KEYCLOAK_AUDIENCE are required");
}
if(!internalUrl || !applicationId || !applicationSecret) {
	throw new Error("KEYCLOAK_INTERNAL_URL, KEYCLOAK_CLIENT_ID, and KEYCLOAK_CLIENT_SECRET are required");
}

const configuration = { issuer, jwksUrl, audience };
const authenticate = createAuthenticationMiddleware(createAccessTokenVerifier(configuration));
const prepareLogout = createLogoutRequestHandler(createLogoutIdTokenVerifier(configuration), issuer);
const keycloakAdminSettings = {
	issuer: new URL(issuer),
	internalUrl: new URL(internalUrl),
	applicationId,
	applicationSecret,
};
const registerClinic = createClinicRequestHandler(keycloakAdminSettings);
const registerUser = createUserRequestHandler(keycloakAdminSettings);
const editUserPermissions = updateUserPermissionsRequestHandler(keycloakAdminSettings);

router.post("/auth/logout-request", authenticate, prepareLogout);
router.get("/audit-records", authenticate, requireRoles(UserRole.clinicAdministrator), listAuditRecords);
router.post("/clinics", authenticate, requireRoles(UserRole.platformAdministrator), registerClinic);
router.post("/users", authenticate, requireRoles(UserRole.clinicAdministrator), registerUser);
router.patch("/users/:userId", authenticate, requireRoles(UserRole.clinicAdministrator), editUserPermissions);
router.post("/specialties", authenticate, requireRoles(UserRole.clinicAdministrator), registerSpecialty);
router.post("/services", authenticate, requireRoles(UserRole.clinicAdministrator), registerService);
router.patch("/services/:serviceId", authenticate, requireRoles(UserRole.clinicAdministrator), editService);
router.post("/patients", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.reception), registerPatient);
router.patch("/patients/:patientId", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.reception), editPatient);
router.get("/patients/:patientId", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.reception, UserRole.healthcareProfessional), getPatient);
router.get("/patients/:patientId/appointments", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.reception, UserRole.healthcareProfessional), listPatientAppointments); 
router.get("/appointments/agenda", authenticate, requireRoles(UserRole.reception), listClinicAgenda);
router.get("/appointments/counts", authenticate, requireRoles(UserRole.clinicAdministrator), getAppointmentCounts);
router.get("/professionals/me/agenda", authenticate, requireRoles(UserRole.healthcareProfessional), listOwnAgenda);
router.get("/professionals/:professionalId/agenda", authenticate, requireRoles(UserRole.reception), listProfessionalAgenda);
router.post("/appointments/:appointmentId/clinical-note", authenticate, requireRoles(UserRole.healthcareProfessional), registerClinicalNote);
router.get("/appointments/:appointmentId/clinical-note", authenticate, requireRoles(UserRole.healthcareProfessional), getClinicalNote);
router.post("/professionals", authenticate, requireRoles(UserRole.clinicAdministrator), registerProfessional);
router.put("/professionals/:professionalId/schedules", authenticate, requireRoles(UserRole.clinicAdministrator, UserRole.healthcareProfessional), replaceSchedules);
router.patch("/professionals/:professionalId", authenticate, requireRoles(UserRole.clinicAdministrator), editProfessionalSpecialty);
router.post("/professionals/:professionalId/services", authenticate, requireRoles(UserRole.clinicAdministrator), registerProfessionalService);
router.patch(
	"/professionals/:professionalId/services/:serviceId",
	authenticate,
	requireRoles(UserRole.clinicAdministrator),
	editProfessionalServiceActivity,
);

app.listen({ port, host }, (error) => {

	if(error) {
		console.error(error.message);
		process.exitCode = 1;

		return;
	}

	console.info(`API listening on ${host}:${port}`);

});
