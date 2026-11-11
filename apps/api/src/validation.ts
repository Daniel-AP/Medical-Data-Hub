const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string => {
	return typeof value === "string" && uuidPattern.test(value);
};

export const isRequiredText = (value: unknown, maxLength: number): value is string => {
	return typeof value === "string" && value.trim() !== "" && [...value].length <= maxLength && !value.includes("\0");
};

export const isCalendarDate = (value: unknown): value is string => {

	if(typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return false;
	}
	const parsed = new Date(`${value}T00:00:00Z`);

	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && !value.startsWith("0000");

};
