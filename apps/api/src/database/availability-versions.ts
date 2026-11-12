import type { TransactionClient } from "./types.js";

export const incrementAvailabilityVersion = async (transaction: TransactionClient, clinicId: string) => {

	const { rowCount } = await transaction.query(
		"UPDATE public.clinic_availability_versions SET version = version+1 WHERE clinic_id = $1::uuid",
		[clinicId],
	);
	if(rowCount !== 1) {
		throw new Error("Missing clinic availability version");
	}

};
