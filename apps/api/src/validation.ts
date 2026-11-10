const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string => {
	return typeof value === "string" && uuidPattern.test(value);
};

export const isRequiredText = (value: unknown, maxLength: number): value is string => {
	return typeof value === "string" && value.trim() !== "" && [...value].length <= maxLength && !value.includes("\0");
};
