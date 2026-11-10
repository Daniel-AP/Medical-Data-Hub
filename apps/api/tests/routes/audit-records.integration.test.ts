import { expect, it } from "vitest";
import type { readAuditRecords } from "../../src/database/audit/read-records.js";

type AuditRecord = Omit<Awaited<ReturnType<typeof readAuditRecords>>[number], "occurredAt"> & { occurredAt: string };
type AuditResponse = { records: AuditRecord[] };

const apiUrl = process.env.AUDIT_TEST_API_URL;
const administratorToken = process.env.AUDIT_TEST_ADMIN_TOKEN;
const foreignAdministratorToken = process.env.AUDIT_TEST_FOREIGN_ADMIN_TOKEN;
const receptionToken = process.env.AUDIT_TEST_RECEPTION_TOKEN;
if(!apiUrl || !administratorToken || !foreignAdministratorToken || !receptionToken) {
	throw new Error("Set AUDIT_TEST_API_URL and the three AUDIT_TEST_*_TOKEN variables for isolated HTTP tests");
}
const auditUrl = new URL("/audit-records", apiUrl);

const requestAudit = (token?: string, query?: string | URLSearchParams) => {

	const url = new URL(auditUrl);
	if(query) {
		url.search = query.toString();
	}

	return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });

};

it("requires a valid bearer token to query audit records", async () => {
	expect((await requestAudit()).status).toBe(401);
	expect((await requestAudit("invalid-token")).status).toBe(401);
});

it("rejects a real reception token for the audit route", async () => {
	expect((await requestAudit(receptionToken)).status).toBe(403);
});

it("returns filtered audit metadata with UTC timestamps to a clinic administrator", async () => {

	const response = await requestAudit(administratorToken);
	expect(response.status).toBe(200);
	const { records }: AuditResponse = await response.json();
	const record = records.find(({ resource }) => resource === "clinical_note")!;
	const occurredAt = new Date(record.occurredAt);
	expect(record).toEqual({
		auditRecordId: expect.any(String),
		clinicId: expect.any(String),
		userId: expect.any(String),
		patientId: expect.any(String),
		resource: "clinical_note",
		appointmentId: expect.any(String),
		action: expect.stringMatching(/^(read|write)$/),
		occurredAt: occurredAt.toISOString(),
	});

	const from = new Date(occurredAt.getTime()+3_600_000).toISOString().replace("Z", "+01:00");
	const to = new Date(occurredAt.getTime()+1).toISOString();
	const filtered = await requestAudit(
		administratorToken,
		new URLSearchParams({ userId: record.userId, patientId: record.patientId, from, to }),
	);
	expect(filtered.status).toBe(200);
	expect(await filtered.json()).toEqual({
		records: records.filter(
			(event) =>
				event.userId === record.userId &&
				event.patientId === record.patientId &&
				event.occurredAt === record.occurredAt,
		),
	});

});

it("rejects invalid, repeated, and unknown audit filters", async () => {

	const timestamp = "2000-02-01T10:00:00Z";
	const invalidQueries = [
		"userId=invalid",
		"patientId=",
		"from=2000-02-01T10:00:00",
		"from=2000-02-31T10:00:00Z",
		"from=2000-02-01T10:00:00%2B25:00",
		"to=2000-02-01T10:00:00.1234Z",
		`from=${timestamp}&to=${timestamp}`,
		`from=${timestamp}&to=2000-01-01T10:00:00Z`,
		`from=${timestamp}&from=${timestamp}`,
		"unknown=1",
	];
	for(const query of invalidQueries) {
		expect((await requestAudit(administratorToken, query)).status, query).toBe(400);
	}

});

it("prevents clinic overrides and hides audit records matching foreign identifiers", async () => {

	const local = await requestAudit(administratorToken);
	const foreign = await requestAudit(foreignAdministratorToken);
	expect(local.status).toBe(200);
	expect(foreign.status).toBe(200);
	const { records: localRecords }: AuditResponse = await local.json();
	const { records: foreignRecords }: AuditResponse = await foreign.json();
	const [{ clinicId, userId, patientId }] = foreignRecords;
	expect(localRecords.length).toBeGreaterThan(0);
	expect(localRecords.some((record) => record.clinicId === clinicId)).toBe(false);
	expect(foreignRecords.every((record) => record.clinicId === clinicId)).toBe(true);

	const override = await requestAudit(administratorToken, new URLSearchParams({ clinicId }));
	expect(override.status).toBe(400);
	for(const filter of [new URLSearchParams({ userId }), new URLSearchParams({ patientId })]) {
		const response = await requestAudit(administratorToken, filter);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ records: [] });
	}

});
