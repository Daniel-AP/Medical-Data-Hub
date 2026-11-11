import { expect, it } from "vitest";
import { isCalendarDate } from "../src/validation.js";

it("accepts real calendar dates in the supported four-digit year range", () => {
	for(const value of ["0001-01-01", "1990-05-15", "2000-02-29", "9999-12-31"]) {
		expect(isCalendarDate(value), value).toBe(true);
	}
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
