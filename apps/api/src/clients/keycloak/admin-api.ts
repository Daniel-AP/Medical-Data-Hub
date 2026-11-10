import { keycloakHttpTimeoutMs } from "../../config/keycloak-timeout.js";
import { KeycloakRoleUpdatePartialError } from "../../errors/keycloak-role-update-partial.js";
import { OperationOutcomeUnknownError } from "../../errors/operation-outcome-unknown.js";
import { keycloakRoles } from "./roles.js";

export type KeycloakAdminSettings = { issuer: URL; internalUrl: URL; applicationId: string; applicationSecret: string };

type KeycloakAdminAccess = {
	adminUrl: URL;
	applicationId: string;
	headers: { Authorization: string };
	fetchKeycloak: typeof fetch;
};
type ApplicationDetails = { id: string; clientId: string };
type RoleMapping = { id: string; name: string };

const keycloakUnavailable = (cause?: unknown) => {
	return Object.assign(new Error("Keycloak administration unavailable", { cause }), { status: 503 });
};

const fetchFromKeycloak = async (url: URL, options: RequestInit, fetchKeycloak: typeof fetch) => {

	try {

		return await fetchKeycloak(url, {
			...options,
			redirect: "error",
			signal: AbortSignal.timeout(keycloakHttpTimeoutMs),
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
	{ issuer, internalUrl, applicationId, applicationSecret }: KeycloakAdminSettings,
	fetchKeycloak: typeof fetch = fetch,
): Promise<KeycloakAdminAccess> => {

	const realm = issuer.pathname.split("/").filter(Boolean).at(-1);
	const baseUrl = `${internalUrl.href.replace(/\/$/, "")}/`;
	const tokenUrl = new URL(`realms/${realm}/protocol/openid-connect/token`, baseUrl);
	const adminUrl = new URL(`admin/realms/${realm}/`, baseUrl);
	const credentials = Buffer.from(`${applicationId}:${applicationSecret}`).toString("base64");
	const token = await fetchFromKeycloak(tokenUrl, {
		method: "POST",
		headers: { Authorization: `Basic ${credentials}` },
		body: new URLSearchParams({ grant_type: "client_credentials" }),
	}, fetchKeycloak);
	const { access_token: accessToken } = await parseKeycloakJson<{ access_token?: string }>(token);
	if(!accessToken) {
		throw keycloakUnavailable();
	}

	return { adminUrl, applicationId, headers: { Authorization: `Bearer ${accessToken}` }, fetchKeycloak };

};

export const isKeycloakIdentityId = (value: unknown): value is string => {

	const validText = typeof value === "string" && value.trim() !== "" &&
		[...value].length <= 255 && !value.includes("\0");

	return validText && value !== "." && value !== "..";

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
	markKeycloakRoleUpdateStarted: () => void,
) => {

	const options: RequestInit = {
		method,
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify(roles),
		redirect: "error",
		signal: AbortSignal.timeout(keycloakHttpTimeoutMs),
	};
	let response: Response;
	markKeycloakRoleUpdateStarted();
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
	markKeycloakRoleUpdateStarted: () => void,
) => {

	const query = new URLSearchParams({ clientId: access.applicationId });
	const applications = await getKeycloakAdminJson<ApplicationDetails[]>(access, `clients?${query}`);
	const application = applications.find((application) => application.clientId === access.applicationId);
	if(!application) {
		throw keycloakUnavailable();
	}

	const applicationUuid = encodeURIComponent(application.id);
	const mappingPath = `users/${encodeURIComponent(identityId)}/role-mappings/clients/${applicationUuid}`;
	const mappings = await getKeycloakAdminJson<RoleMapping[]>(access, mappingPath);
	const rolesToRemove = mappings.filter(({ name }) => name !== roleName && Object.hasOwn(keycloakRoles, name));
	const mappingUrl = new URL(mappingPath, access.adminUrl);
	let roleAdded = false;

	if(!mappings.some(({ name }) => name === roleName)) {

		const roles = await getKeycloakAdminJson<RoleMapping[]>(access, `clients/${applicationUuid}/roles`);
		const roleToAdd = roles.find(({ name }) => name === roleName);
		if(!roleToAdd) {
			throw keycloakUnavailable();
		}
		await changeKeycloakRoles(access, mappingUrl, "POST", [roleToAdd], markKeycloakRoleUpdateStarted);
		roleAdded = true;

	}
	if(rolesToRemove.length === 0) {
		return;
	}

	try {
		await changeKeycloakRoles(access, mappingUrl, "DELETE", rolesToRemove, markKeycloakRoleUpdateStarted);
	} catch (error) {

		if(roleAdded && !(error instanceof OperationOutcomeUnknownError)) {
			throw new KeycloakRoleUpdatePartialError(error);
		}
		throw error;

	}

};
