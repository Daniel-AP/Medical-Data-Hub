import { app, router } from "./app.js";
import { createAccessTokenVerifier, createLogoutIdTokenVerifier } from "./clients/keycloak/token-verification.js";
import "./config/database-timeouts.js";
import "./config/redis-timeouts.js";
import { UserRole } from "./generated/prisma/enums.js";
import { createAuthenticationMiddleware, requireRoles } from "./middleware/authentication.js";
import { listAuditRecords } from "./routes/audit-records.js";
import { createClinicRequestHandler } from "./routes/clinics.js";
import { createLogoutRequestHandler } from "./routes/logout.js";
import { editService, registerService } from "./routes/services.js";
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

app.listen({ port, host }, (error) => {

	if(error) {
		console.error(error.message);
		process.exitCode = 1;

		return;
	}

	console.info(`API listening on ${host}:${port}`);

});
