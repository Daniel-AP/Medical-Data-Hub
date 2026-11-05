import { app, router } from "./app.js";
import { createAccessTokenVerifier, createLogoutIdTokenVerifier } from "./clients/keycloak.js";
import "./config/database-timeouts.js";
import { createAuthenticationMiddleware } from "./middleware/authentication.js";
import { createLogoutRequestHandler } from "./routes/logout.js";

const host = process.env.HOST;
const port = Number(process.env.PORT);
const issuer = process.env.KEYCLOAK_ISSUER;
const jwksUrl = process.env.KEYCLOAK_JWKS_URL;
const audience = process.env.KEYCLOAK_AUDIENCE;

if (!issuer || !jwksUrl || !audience) {
	throw new Error("KEYCLOAK_ISSUER, KEYCLOAK_JWKS_URL, and KEYCLOAK_AUDIENCE are required");
}

const configuration = { issuer, jwksUrl, audience };
const authenticate = createAuthenticationMiddleware(createAccessTokenVerifier(configuration));
const prepareLogout = createLogoutRequestHandler(createLogoutIdTokenVerifier(configuration), issuer);

router.post("/auth/logout-request", authenticate, prepareLogout);

app.listen({ port, host }, (error) => {
	if (error) {
		console.error(error.message);
		process.exitCode = 1;

		return;
	}

	console.info(`API listening on ${host}:${port}`);
});
