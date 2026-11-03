import { app, router } from "../../src/app.js";
import { createAccessTokenVerifier } from "../../src/clients/keycloak.js";
import { UserRole } from "../../src/generated/prisma/enums.js";
import { createAuthenticationMiddleware, requireRoles } from "../../src/middleware/authentication.js";

const issuer = "http://localhost:8080/realms/medical-data-hub";
const verifyAccessToken = createAccessTokenVerifier({
	issuer,
	audience: "medical-data-hub-api",
	jwksUrl: `${issuer}/protocol/openid-connect/certs`,
});
const authenticate = createAuthenticationMiddleware(verifyAccessToken);

router.get("/authentication-check", authenticate, (request, response) => {
	response.json(request.authentication);
});
router.get(
	"/role-check",
	authenticate,
	requireRoles(UserRole.clinicAdministrator, UserRole.reception),
	(_request, response) => {
		response.sendStatus(204);
	},
);

router.get(
	"/clinic-administrator-check",
	authenticate,
	requireRoles(UserRole.clinicAdministrator),
	(_request, response) => {
		response.sendStatus(204);
	},
);

const verifyWrongIssuer = createAccessTokenVerifier({
	issuer: "http://localhost:8080/realms/another-realm",
	audience: "medical-data-hub-api",
	jwksUrl: `${issuer}/protocol/openid-connect/certs`,
});
const verifyWrongAudience = createAccessTokenVerifier({
	issuer,
	audience: "another-api",
	jwksUrl: `${issuer}/protocol/openid-connect/certs`,
});

router.get("/wrong-issuer-check", createAuthenticationMiddleware(verifyWrongIssuer), (_request, response) => {
	response.sendStatus(204);
});
router.get("/wrong-audience-check", createAuthenticationMiddleware(verifyWrongAudience), (_request, response) => {
	response.sendStatus(204);
});

const verifyColdStart = createAccessTokenVerifier({
	issuer,
	audience: "medical-data-hub-api",
	jwksUrl: `${issuer}/protocol/openid-connect/certs`,
});

router.get("/cold-start-check", createAuthenticationMiddleware(verifyColdStart), (_request, response) => {
	response.sendStatus(204);
});

app.listen({ host: "127.0.0.1", port: 3001 }, (error) => {
	if (error) {
		console.error(error.message);
		process.exitCode = 1;
		return;
	}

	console.info("Authentication probe listening on http://127.0.0.1:3001");
});
