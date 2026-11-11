import { expect, it } from "vitest";
import { isCalendarDate, parseTimestamp } from "../src/validation.js";

it("accepts real calendar dates in the supported four-digit year range", () => {
	for(const value of ["0001-01-01", "1990-05-15", "2000-02-29", "9999-12-31"]) {
		expect(isCalendarDate(value), value).toBe(true);
	}
});

it("parses finite ISO timestamps with explicit offsets at millisecond precision", () => {

	const values = [
		["2030-01-07T08:00-06", "2030-01-07T14:00:00.000Z"],
		["2030-01-07T08:00:00.1-0600", "2030-01-07T14:00:00.100Z"],
		["2030-01-07T14:00:00.123Z", "2030-01-07T14:00:00.123Z"],
		["2030-01-07T20:00:00.123+06:00", "2030-01-07T14:00:00.123Z"],
	];
	for(const [value, expected] of values) {
		expect(parseTimestamp(value)).toEqual(new Date(expected));
	}

});

it("rejects malformed timestamps, invalid local dates, offsets, and excess precision", () => {

	const values = [
		null, 42, "infinity", "2030-01-07T08:00", "2030-02-30T08:00Z",
		"2030-01-07T24:00Z", "2030-01-07T08:00+24:00", "2030-01-07T08:00:00.1234Z",
	];
	for(const value of values) {
		expect(() => parseTimestamp(value)).toThrow(expect.objectContaining({ status: 400 }));
	}

});

it("preserves omitted optional timestamps", () => {
	expect(parseTimestamp(undefined)).toBeUndefined();
});

it("rejects invalid calendar dates and non-date values", () => {

	const values = [
		undefined, null, 19900515, "",
		"0000-01-01", "1900-02-29", "2026-04-31", "2026-13-01",
		"2026-1-01", "1990-05-15T00:00:00Z", "1990-05-15\n",
	];
	for(const value of values) {
		expect(isCalendarDate(value), String(value)).toBe(false);
	}

});
