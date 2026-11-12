import { expect, it } from "vitest";
import { calculateDailyAvailability, filterFutureStarts, prepareAvailabilityCalendar } from "../../src/database/availability-calculation.js";

it("joins overlapping and adjacent coverage while preserving gaps", () => {

	const calendar = prepareAvailabilityCalendar("2030-01-07", "2030-01-07", "UTC");
	const week = [
		{ weekday: 1, startMinute: 542, endMinute: 544 },
		{ weekday: 1, startMinute: 540, endMinute: 542 },
		{ weekday: 1, startMinute: 541, endMinute: 543 },
		{ weekday: 1, startMinute: 545, endMinute: 547 },
	];

	expect(calculateDailyAvailability(calendar, week, [], 2)).toEqual([{
		localDate: "2030-01-07",
		starts: [
			"2030-01-07T09:00:00.000Z",
			"2030-01-07T09:01:00.000Z",
			"2030-01-07T09:02:00.000Z",
			"2030-01-07T09:05:00.000Z",
		],
	}]);

});

it("uses coverage and occupation after the last requested local date", () => {

	const calendar = prepareAvailabilityCalendar("2030-01-06", "2030-01-06", "UTC");
	const week = [
		{ weekday: 7, startMinute: 1438, endMinute: 1440 },
		{ weekday: 1, startMinute: 0, endMinute: 2 },
	];
	const occupation = [{ startAt: new Date("2030-01-07T00:01Z"), endAt: new Date("2030-01-07T00:02Z") }];

	expect(calculateDailyAvailability(calendar, week, [], 3)).toEqual([{
		localDate: "2030-01-06",
		starts: ["2030-01-06T23:58:00.000Z", "2030-01-06T23:59:00.000Z"],
	}]);
	expect(calculateDailyAvailability(calendar, week, occupation, 3)).toEqual([{
		localDate: "2030-01-06",
		starts: ["2030-01-06T23:58:00.000Z"],
	}]);

});

it("subtracts merged occupation across midnight and aligns starts to UTC minutes", () => {

	const calendar = prepareAvailabilityCalendar("2030-01-07", "2030-01-07", "UTC");
	const week = [{ weekday: 1, startMinute: 0, endMinute: 6 }];
	const occupation = [
		{ startAt: new Date("2030-01-07T00:02Z"), endAt: new Date("2030-01-07T00:03:30Z") },
		{ startAt: new Date("2030-01-06T23:59Z"), endAt: new Date("2030-01-07T00:01:30Z") },
		{ startAt: new Date("2030-01-07T00:01Z"), endAt: new Date("2030-01-07T00:02Z") },
	];

	expect(calculateDailyAvailability(calendar, week, occupation, 2)).toEqual([{
		localDate: "2030-01-07",
		starts: ["2030-01-07T00:04:00.000Z"],
	}]);

});

it("fits the maximum service duration in a continuous weekly schedule", () => {

	const calendar = prepareAvailabilityCalendar("2030-01-07", "2030-01-07", "UTC");
	const week = Array.from({ length: 7 }, (_, day) => ({ weekday: day+1, startMinute: 0, endMinute: 1440 }));
	const [day] = calculateDailyAvailability(calendar, week, [], 2_147_483_647);

	expect(day.starts).toHaveLength(1440);
	expect(day.starts.at(-1)).toBe("2030-01-07T23:59:00.000Z");

});

it("skips nonexistent local times and retains both occurrences of repeated times", () => {

	const spring = prepareAvailabilityCalendar("2024-03-10", "2024-03-10", "America/New_York");
	const fall = prepareAvailabilityCalendar("2024-11-03", "2024-11-03", "America/New_York");

	expect(calculateDailyAvailability(spring, [{ weekday: 7, startMinute: 150, endMinute: 182 }], [], 2)).toEqual([{
		localDate: "2024-03-10",
		starts: ["2024-03-10T07:00:00.000Z"],
	}]);
	expect(calculateDailyAvailability(fall, [{ weekday: 7, startMinute: 90, endMinute: 92 }], [], 2)).toEqual([{
		localDate: "2024-11-03",
		starts: ["2024-11-03T05:30:00.000Z", "2024-11-03T06:30:00.000Z"],
	}]);

});

it("respects offset transitions between UTC minute boundaries", () => {

	const calendar = prepareAvailabilityCalendar("1972-01-07", "1972-01-07", "Africa/Monrovia");
	const week = [{ weekday: 5, startMinute: 44, endMinute: 47 }];

	expect(calculateDailyAvailability(calendar, week, [], 1)).toEqual([{
		localDate: "1972-01-07",
		starts: ["1972-01-07T00:45:00.000Z", "1972-01-07T00:46:00.000Z"],
	}]);

});

it("materializes an empty unit for a skipped local date", () => {

	const calendar = prepareAvailabilityCalendar("2011-12-29", "2011-12-31", "Pacific/Apia");
	const week = [4, 5, 6].map((weekday) => ({ weekday, startMinute: 480, endMinute: 482 }));

	expect(calculateDailyAvailability(calendar, week, [], 2)).toEqual([
		{ localDate: "2011-12-29", starts: ["2011-12-29T18:00:00.000Z"] },
		{ localDate: "2011-12-30", starts: [] },
		{ localDate: "2011-12-31", starts: ["2011-12-30T18:00:00.000Z"] },
	]);

});

it("filters starts for clinic-local today strictly after the fixed reference", () => {

	const units = [
		{ localDate: "2030-01-07", starts: ["2030-01-08T01:59:00.000Z", "2030-01-08T02:00:00.000Z", "2030-01-08T02:01:00.000Z"] },
		{ localDate: "2030-01-08", starts: ["2030-01-08T06:00:00.000Z"] },
	];
	const now = new Date("2030-01-08T02:00:00.000Z");

	expect(filterFutureStarts(units, "America/Costa_Rica", now)).toEqual([
		{ localDate: "2030-01-07", starts: ["2030-01-08T02:01:00.000Z"] },
		{ localDate: "2030-01-08", starts: ["2030-01-08T06:00:00.000Z"] },
	]);
	expect(units[0].starts).toHaveLength(3);

});
