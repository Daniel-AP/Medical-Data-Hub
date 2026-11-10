import { app, router } from "./app.js";
import { createAccessTokenVerifier, createLogoutIdTokenVerifier } from "./clients/keycloak/token-verification.js";
import "./config/database-timeouts.js";
import "./config/redis-timeouts.js";
import { UserRole } from "./generated/prisma/enums.js";
import { createAuthenticationMiddleware, requireRoles } from "./middleware/authentication.js";
import { listAuditRecords } from "./routes/audit-records.js";
import { createLogoutRequestHandler } from "./routes/logout.js";

const host = process.env.HOST;
const port = Number(process.env.PORT);
const issuer = process.env.KEYCLOAK_ISSUER;
const jwksUrl = process.env.KEYCLOAK_JWKS_URL;
const audience = process.env.KEYCLOAK_AUDIENCE;

if(!issuer || !jwksUrl || !audience) {
	throw new Error("KEYCLOAK_ISSUER, KEYCLOAK_JWKS_URL, and KEYCLOAK_AUDIENCE are required");
}

const configuration = { issuer, jwksUrl, audience };
const authenticate = createAuthenticationMiddleware(createAccessTokenVerifier(configuration));
const prepareLogout = createLogoutRequestHandler(createLogoutIdTokenVerifier(configuration), issuer);

router.post("/auth/logout-request", authenticate, prepareLogout);
router.get("/audit-records", authenticate, requireRoles(UserRole.clinicAdministrator), listAuditRecords);

app.listen({ port, host }, (error) => {

	if(error) {
		console.error(error.message);
		process.exitCode = 1;

		return;
	}

	console.info(`API listening on ${host}:${port}`);

});
