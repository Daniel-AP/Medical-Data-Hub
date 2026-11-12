import { keycloakTimeouts } from "../config/keycloak-timeouts.js";
import { KeycloakRoleUpdatePartialError } from "../errors/keycloak-role-update-partial.js";
import { OperationOutcomeUnknownError } from "../errors/operation-outcome-unknown.js";
import { isRequiredText } from "../validation.js";
import { keycloakRoles } from "./keycloak-roles.js";
import type { KeycloakAdminSettings } from "./types.js";

type KeycloakAdminAccess = {
	adminUrl: URL;
	clientId: string;
	headers: { Authorization: string };
	fetchKeycloak: typeof fetch;
};
type KeycloakClient = { id: string; clientId: string };
type RoleMapping = { id: string; name: string };

const keycloakUnavailable = (cause?: unknown) => {
	return Object.assign(new Error("Keycloak administration unavailable", { cause }), { status: 503 });
};

const fetchFromKeycloak = async (url: URL, options: RequestInit, fetchKeycloak: typeof fetch) => {

	try {

		return await fetchKeycloak(url, {
			...options,
			redirect: "error",
			signal: AbortSignal.timeout(keycloakTimeouts.requestMs),
		});

	} catch (error) {
		throw keycloakUnavailable(error);
	}

};

const parseKeycloakJson = async <T>(response: Response): Promise<T> => {

	if(response.status !== 200) {
		throw keycloakUnavailable();
	}

	try {
		return await response.json() as T;
	} catch (error) {
		throw keycloakUnavailable(error);
	}

};

export const getKeycloakAdminAccess = async (
	{ issuer, internalUrl, clientId, clientSecret }: KeycloakAdminSettings,
	fetchKeycloak: typeof fetch = fetch,
): Promise<KeycloakAdminAccess> => {

	const realm = issuer.pathname.split("/").filter(Boolean).at(-1);
	const baseUrl = `${internalUrl.href.replace(/\/$/, "")}/`;
	const tokenUrl = new URL(`realms/${realm}/protocol/openid-connect/token`, baseUrl);
	const adminUrl = new URL(`admin/realms/${realm}/`, baseUrl);
	const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
	const token = await fetchFromKeycloak(tokenUrl, {
		method: "POST",
		headers: { Authorization: `Basic ${credentials}` },
		body: new URLSearchParams({ grant_type: "client_credentials" }),
	}, fetchKeycloak);
	const { access_token: accessToken } = await parseKeycloakJson<{ access_token?: string }>(token);
	if(!accessToken) {
		throw keycloakUnavailable();
	}

	return { adminUrl, clientId, headers: { Authorization: `Bearer ${accessToken}` }, fetchKeycloak };

};

export const isKeycloakIdentityId = (value: unknown): value is string => {
	return isRequiredText(value, 255) && value !== "." && value !== "..";
};

export const keycloakUserExists = async ({ adminUrl, headers, fetchKeycloak }: KeycloakAdminAccess, identityId: string) => {

	const url = new URL(`users/${encodeURIComponent(identityId)}`, adminUrl);
	const response = await fetchFromKeycloak(url, { headers }, fetchKeycloak);
	if(response.status === 404) {
		await response.body?.cancel();

		return false;
	}
	await parseKeycloakJson(response);

	return true;

};

const getKeycloakAdminJson = async <T>({ adminUrl, headers, fetchKeycloak }: KeycloakAdminAccess, path: string) => {
	return parseKeycloakJson<T>(await fetchFromKeycloak(new URL(path, adminUrl), { headers }, fetchKeycloak));
};

const changeKeycloakRoles = async (
	{ headers, fetchKeycloak }: KeycloakAdminAccess,
	mappingUrl: URL,
	method: "POST" | "DELETE",
	roles: RoleMapping[],
	markRoleUpdateStarted: () => void,
) => {

	const options: RequestInit = {
		method,
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify(roles),
		redirect: "error",
		signal: AbortSignal.timeout(keycloakTimeouts.requestMs),
	};
	let response: Response;
	markRoleUpdateStarted();
	try {
		response = await fetchKeycloak(mappingUrl, options);
	} catch (error) {
		throw new OperationOutcomeUnknownError(error);
	}
	if(response.status === 204) {
		return;
	}

	const error = new Error(`Keycloak role update returned HTTP ${response.status}`);
	const rejected = response.status >= 400 && response.status < 500 && response.status !== 408;
	if(rejected) {
		throw error;
	}

	throw new OperationOutcomeUnknownError(error);

};

export const replaceKeycloakUserRole = async (
	access: KeycloakAdminAccess,
	identityId: string,
	roleName: keyof typeof keycloakRoles,
	markRoleUpdateStarted: () => void,
) => {

	const query = new URLSearchParams({ clientId: access.clientId });
	const clients = await getKeycloakAdminJson<KeycloakClient[]>(access, `clients?${query}`);
	const client = clients.find((client) => client.clientId === access.clientId);
	if(!client) {
		throw keycloakUnavailable();
	}

	const clientUuid = encodeURIComponent(client.id);
	const mappingPath = `users/${encodeURIComponent(identityId)}/role-mappings/clients/${clientUuid}`;
	const mappings = await getKeycloakAdminJson<RoleMapping[]>(access, mappingPath);
	const rolesToRemove = mappings.filter(({ name }) => name !== roleName && Object.hasOwn(keycloakRoles, name));
	const mappingUrl = new URL(mappingPath, access.adminUrl);
	let roleAdded = false;

	if(!mappings.some(({ name }) => name === roleName)) {

		const roles = await getKeycloakAdminJson<RoleMapping[]>(access, `clients/${clientUuid}/roles`);
		const roleToAdd = roles.find(({ name }) => name === roleName);
		if(!roleToAdd) {
			throw keycloakUnavailable();
		}
		await changeKeycloakRoles(access, mappingUrl, "POST", [roleToAdd], markRoleUpdateStarted);
		roleAdded = true;

	}
	if(rolesToRemove.length === 0) {
		return;
	}

	try {
		await changeKeycloakRoles(access, mappingUrl, "DELETE", rolesToRemove, markRoleUpdateStarted);
	} catch (error) {

		if(roleAdded && !(error instanceof OperationOutcomeUnknownError)) {
			throw new KeycloakRoleUpdatePartialError(error);
		}
		throw error;

	}

};
