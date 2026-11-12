import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

type Realm = {
	clients: { clientId: string; redirectUris?: string[] }[];
	users: { username: string; credentials?: { type: string; value: string }[] }[];
};

type Session = { access_token: string; refresh_token: string };

const realm = JSON.parse(readFileSync("infra/keycloak/development/medical-data-hub-realm.json", "utf8")) as Realm;
const clientId = "medical-data-hub-postman";

const request = (url: string | URL, signal: AbortSignal, options?: RequestInit) => {
	return fetch(url, { ...options, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
};

const exchangeToken = async (issuer: string, body: URLSearchParams, signal: AbortSignal) => {

	const response = await request(issuer+"/protocol/openid-connect/token", signal, { method: "POST", body });
	if(!response.ok) {
		throw new Error(`Keycloak token request failed with HTTP ${response.status}`);
	}

	return await response.json() as Session;

};

export const signInTestUser = async (issuer: string, username: string, signal: AbortSignal) => {

	const redirectUri = realm.clients.find((client) => client.clientId === clientId)?.redirectUris?.[0];
	const password = realm.users.find((user) => user.username === username)?.credentials?.find((credential) => credential.type === "password")?.value;
	if(!redirectUri || !password) {
		throw new Error(`Missing development Keycloak fixture for ${username}`);
	}

	const verifier = randomBytes(32).toString("base64url");
	const state = randomBytes(16).toString("base64url");
	const query = new URLSearchParams({
		client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid", state,
		code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
	});
	const login = await request(issuer+"/protocol/openid-connect/auth?"+query, signal);
	if(!login.ok) {
		throw new Error(`Keycloak authorization request failed with HTTP ${login.status}`);
	}
	const form = (await login.text()).match(/<form\b[^>]*\bid="kc-form-login"[^>]*>/)?.[0];
	const action = form?.match(/\baction="([^"]+)"/)?.[1].replaceAll("&amp;", "&");
	if(!action || new URL(action, issuer).origin !== new URL(issuer).origin) {
		throw new Error("Keycloak login form is missing a local action");
	}

	const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
	const submitted = await request(new URL(action, issuer), signal, {
		method: "POST", headers: { cookie }, body: new URLSearchParams({ username, password }),
	});
	const location = submitted.headers.get("location");
	if(!location || (submitted.status !== 302 && submitted.status !== 303)) {
		throw new Error(`Keycloak login did not redirect to the callback (HTTP ${submitted.status})`);
	}
	const callback = new URL(location);
	const code = callback.searchParams.get("code");
	const validCallback = callback.origin+callback.pathname === redirectUri && callback.searchParams.get("state") === state;
	if(!validCallback || !code) {
		throw new Error("Keycloak login returned an invalid authorization callback");
	}

	return exchangeToken(issuer, new URLSearchParams({
		grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri, code, code_verifier: verifier,
	}), signal);

};

export const signInTestAdministrator = async (keycloakUrl: string, username: string, password: string, signal: AbortSignal) => {

	const session = await exchangeToken(keycloakUrl+"/realms/master", new URLSearchParams({
		grant_type: "password", client_id: "admin-cli", username, password,
	}), signal);

	return session.access_token;

};
