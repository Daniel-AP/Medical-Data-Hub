const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestampPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}(?::?\d{2})?)$/;

const invalidTimestamp = () => {
	return Object.assign(new Error("Invalid timestamp"), { status: 400 });
};

export const parseTimestamp = (value: unknown) => {

	if(value === undefined) {
		return undefined;
	}
	const match = typeof value === "string" ? timestampPattern.exec(value) : null;
	if(!match) {
		throw invalidTimestamp();
	}

	const [, minute, second = "00", fraction = "", offset] = match;
	const local = `${minute}:${second}.${fraction.padEnd(3, "0")}`;
	const localAsUtc = new Date(`${local}Z`);
	if(Number.isNaN(localAsUtc.getTime()) || localAsUtc.toISOString() !== `${local}Z`) {
		throw invalidTimestamp();
	}

	const instant = new Date(`${local}${offset.length === 3 ? `${offset}:00` : offset}`);
	if(Number.isNaN(instant.getTime())) {
		throw invalidTimestamp();
	}

	return instant;

};

export const isUuid = (value: unknown): value is string => {
	return typeof value === "string" && uuidPattern.test(value);
};

export const isRequiredText = (value: unknown, maxLength: number): value is string => {
	return typeof value === "string" && value.trim() !== "" && [...value].length <= maxLength && !value.includes("\0");
};

export const isEmail = (value: unknown): value is string => {
	return isRequiredText(value, 320) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
};

export const isPhone = (value: unknown): value is string => {
	return isRequiredText(value, 32) && /^\+?[0-9 ()-]+$/.test(value) && /[0-9]/.test(value);
};

export const isCalendarDate = (value: unknown): value is string => {

	if(typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return false;
	}
	const parsed = new Date(`${value}T00:00:00Z`);

	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && !value.startsWith("0000");

};
