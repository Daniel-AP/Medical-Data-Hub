import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

const setupConnectionString = process.env.DATABASE_SETUP_URL;
if(!setupConnectionString) {
	throw new Error("DATABASE_SETUP_URL is required for isolated database tests");
}

const setup = new Client({ connectionString: setupConnectionString });
const profileNames = ["clinic_administrator", "reception", "healthcare_professional"];
const applicationRoles = ["medical_data_hub_api", "platform_administrator", ...profileNames];
const mutations = [
	{ label: "UPDATE without matching rows", query: "UPDATE public.audit_records SET action = 'read' WHERE false" },
	{ label: "DELETE without matching rows", query: "DELETE FROM public.audit_records WHERE false" },
	{ label: "TRUNCATE", query: "TRUNCATE public.audit_records" },
];
const auditQuery = "SELECT * FROM public.audit_records ORDER BY audit_record_id";
let originalRecords: Record<string, unknown>[];

beforeAll(async () => {
	await setup.connect();
	originalRecords = (await setup.query(auditQuery)).rows;
	expect(originalRecords.length).toBeGreaterThan(0);
});

beforeEach(async () => {
	await setup.query("BEGIN");
});

afterEach(async () => {
	await setup.query("ROLLBACK");
});

afterAll(async () => {
	await setup.end();
});

it.each(mutations)(
	"rejects audit $label through the append-only trigger despite temporary grants",
	async ({ query }) => {

		await setup.query("GRANT UPDATE, DELETE, TRUNCATE ON public.audit_records TO clinic_administrator");
		await setup.query("SET LOCAL ROLE clinic_administrator");
		await expect(setup.query(query)).rejects.toMatchObject({
			code: "55000",
			message: "audit_records is append-only",
		});
		await setup.query("ROLLBACK");
		expect((await setup.query(auditQuery)).rows).toEqual(originalRecords);

	},
);

it("allows audit insertion and removes the uncommitted event on rollback", async () => {

	const inserted = await setup.query(`
        INSERT INTO public.audit_records (clinic_id, user_id, patient_id, resource, appointment_id, action)
        SELECT clinic_id, user_id, patient_id, resource, appointment_id, action
        FROM public.audit_records ORDER BY audit_record_id LIMIT 1
        RETURNING audit_record_id
    `);
	const auditRecordId = inserted.rows[0].audit_record_id;
	expect(inserted.rowCount).toBe(1);
	expect(
		(await setup.query("SELECT 1 FROM public.audit_records WHERE audit_record_id = $1::uuid", [auditRecordId]))
			.rowCount,
	).toBe(1);
	await setup.query("ROLLBACK");
	expect(
		(await setup.query("SELECT 1 FROM public.audit_records WHERE audit_record_id = $1::uuid", [auditRecordId]))
			.rows,
	).toEqual([]);
	expect((await setup.query(auditQuery)).rows).toEqual(originalRecords);

});

it("keeps audit mutation privileges absent after rolling back temporary test grants", async () => {

	const { rows } = await setup.query(
		`
        SELECT role_name, privilege
        FROM unnest($1::text[]) AS role_name
        CROSS JOIN unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS privilege
        WHERE pg_catalog.has_table_privilege(role_name, 'public.audit_records', privilege)
            OR (privilege = 'UPDATE' AND pg_catalog.has_any_column_privilege(role_name, 'public.audit_records', 'UPDATE'))
    `,
		[applicationRoles],
	);
	expect(rows).toEqual([]);

});
