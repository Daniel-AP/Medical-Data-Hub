import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { app, router } from "../../src/app.js";
import { createAccessTokenVerifier, createLogoutIdTokenVerifier } from "../../src/clients/keycloak-tokens.js";
import { createAuthentication } from "../../src/middleware/authentication.js";
import { createLogoutHandler } from "../../src/routes/logout.js";

type TokenResponse = { access_token: string; id_token: string; refresh_token: string };

const refreshTokenA = process.env.KEYCLOAK_LOGOUT_REFRESH_TOKEN;
const refreshTokenB = process.env.KEYCLOAK_OTHER_REFRESH_TOKEN;
if(!refreshTokenA || !refreshTokenB) {
	throw new Error("Set KEYCLOAK_LOGOUT_REFRESH_TOKEN and KEYCLOAK_OTHER_REFRESH_TOKEN to two active sessions");
}

const issuer = "http://localhost:8080/realms/medical-data-hub";
const clientId = "medical-data-hub-postman";
const configuration = { issuer, audience: "medical-data-hub-api", jwksUrl: `${issuer}/protocol/openid-connect/certs` };
const verifyAccessToken = createAccessTokenVerifier(configuration);
let server: Server;
let url: string;

const requestRefresh = (refreshToken: string) => {

	return fetch(`${issuer}/protocol/openid-connect/token`, {
		method: "POST",
		body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
	});

};

beforeAll(async () => {

	router.post(
		"/auth/logout-request",
		createAuthentication(verifyAccessToken),
		createLogoutHandler(createLogoutIdTokenVerifier(configuration), issuer),
	);

	server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/logout-request`;

});

afterAll(async () => {
	server.close();
	await once(server, "close");
});

it("closes only the requested Keycloak session while preserving another session and issued access tokens", async () => {

	const initialRefreshA = await requestRefresh(refreshTokenA);
	expect(initialRefreshA.status).toBe(200);
	let tokensA: TokenResponse = await initialRefreshA.json();
	const initialRefreshB = await requestRefresh(refreshTokenB);
	expect(initialRefreshB.status).toBe(200);
	const tokensB: TokenResponse = await initialRefreshB.json();

	const identityA = await verifyAccessToken(tokensA.access_token);
	const identityB = await verifyAccessToken(tokensB.access_token);
	expect(identityA.sub).toBe(identityB.sub);
	expect(identityA.sid).toBeTypeOf("string");
	expect(identityB.sid).toBeTypeOf("string");
	expect(identityA.sid).not.toBe("");
	expect(identityB.sid).not.toBe("");
	expect(identityA.sid).not.toBe(identityB.sid);

	const requestOptions = {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokensA.access_token}` },
		body: JSON.stringify({ idToken: tokensA.id_token }),
	};
	const mixedSessionResponse = await fetch(url, {
		...requestOptions,
		body: JSON.stringify({ idToken: tokensB.id_token }),
	});
	expect(mixedSessionResponse.status).toBe(401);

	const preparedResponse = await fetch(url, requestOptions);
	expect(preparedResponse.status).toBe(200);
	expect(preparedResponse.headers.get("cache-control")).toBe("no-store");
	const { logoutUrl } = await preparedResponse.json();
	expect(typeof logoutUrl).toBe("string");
	expect(URL.canParse(logoutUrl)).toBe(true);
	const logoutAddress = new URL(logoutUrl);
	expect(`${logoutAddress.origin}${logoutAddress.pathname}`).toBe(`${issuer}/protocol/openid-connect/logout`);
	expect(logoutAddress.searchParams.get("id_token_hint") === tokensA.id_token).toBe(true);
	expect(logoutAddress.searchParams.get("client_id")).toBe(clientId);

	const refreshBeforeLogout = await requestRefresh(tokensA.refresh_token);
	expect(refreshBeforeLogout.status).toBe(200);
	tokensA = await refreshBeforeLogout.json();

	const logoutResponse = await fetch(logoutUrl, { redirect: "manual" });
	expect(logoutResponse.status).toBe(200);
	expect((await logoutResponse.text()).includes("You are logged out")).toBe(true);

	const remainingAccessResponse = await fetch(url, requestOptions);
	expect(remainingAccessResponse.status).toBe(200);

	const rejectedRefresh = await requestRefresh(tokensA.refresh_token);
	expect(rejectedRefresh.status).toBe(400);
	expect((await rejectedRefresh.json()).error).toBe("invalid_grant");

	const survivingRefresh = await requestRefresh(tokensB.refresh_token);
	expect(survivingRefresh.status).toBe(200);
	const survivingTokens: TokenResponse = await survivingRefresh.json();
	const survivingIdentity = await verifyAccessToken(survivingTokens.access_token);
	expect(survivingIdentity.sub).toBe(identityB.sub);
	expect(survivingIdentity.sid).toBe(identityB.sid);
	expect(survivingIdentity.resource_access).toEqual(identityB.resource_access);

}, 30_000);
