import type { Request, Response as ExpressResponse } from "express";
import { expect, it, vi } from "vitest";
import { runAuthorizedTransaction } from "../../src/database/authorization.js";
import { UserRole } from "../../src/generated/prisma/enums.js";
import { createClinicHandler } from "../../src/routes/clinics.js";

vi.mock("../../src/database/authorization.js", () => ({
	runAuthorizedTransaction: vi.fn(),
}));

it("rejects clinic registration before contacting Keycloak when the actor has no local access", async () => {

	vi.mocked(runAuthorizedTransaction).mockRejectedValueOnce(Object.assign(new Error("Operation forbidden"), { status: 403 }));
	const fetchKeycloak = vi.fn<typeof fetch>();
	const handler = createClinicHandler({
		issuer: new URL("https://keycloak.example/realms/test"),
		internalUrl: new URL("https://keycloak.example"),
		clientId: "test-api",
		clientSecret: "synthetic",
	}, fetchKeycloak);
	const request = {
		body: { name: "Synthetic Clinic", timeZone: "UTC", administratorIdentityId: "missing-identity" },
		authentication: { identityId: "unlinked-actor", roles: [UserRole.platformAdministrator] },
	} as Request;

	await expect(handler(request, {} as ExpressResponse, vi.fn())).rejects.toMatchObject({ status: 403 });
	expect(fetchKeycloak).not.toHaveBeenCalled();

});
