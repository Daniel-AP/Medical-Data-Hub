import { expect, it } from "vitest";
import { isScheduleCovered } from "../../src/database/schedule-coverage.js";

it.each([
	{ name: "an empty week", week: [], start: "2030-01-07T08:00Z", end: "2030-01-07T09:00Z" },
	{
		name: "a gap between intervals",
		week: [{ weekday: 1, startMinute: 480, endMinute: 540 }, { weekday: 1, startMinute: 541, endMinute: 600 }],
		start: "2030-01-07T08:30Z", end: "2030-01-07T09:30Z",
	},
	{
		name: "a start at the exclusive end",
		week: [{ weekday: 1, startMinute: 480, endMinute: 540 }],
		start: "2030-01-07T09:00Z", end: "2030-01-07T09:30Z",
	},
	{
		name: "partial coverage at the start",
		week: [{ weekday: 1, startMinute: 480, endMinute: 540 }],
		start: "2030-01-07T07:59Z", end: "2030-01-07T08:30Z",
	},
])("rejects $name", ({ week, start, end }) => {
	expect(isScheduleCovered(week, new Date(start), new Date(end), "UTC")).toBe(false);
});

it.each([
	{
		name: "minute 1440 across Sunday and Monday",
		zone: "UTC",
		week: [{ weekday: 7, startMinute: 1380, endMinute: 1440 }, { weekday: 1, startMinute: 0, endMinute: 60 }],
		start: "2030-01-06T23:30Z", end: "2030-01-07T00:30Z",
	},
	{
		name: "nonexistent hours without shifting the schedule",
		zone: "America/New_York",
		week: [{ weekday: 7, startMinute: 150, endMinute: 240 }],
		start: "2024-03-10T07:00Z", end: "2024-03-10T08:00Z",
	},
	{
		name: "the first occurrence of a repeated interval",
		zone: "America/New_York",
		week: [{ weekday: 7, startMinute: 90, endMinute: 105 }],
		start: "2024-11-03T05:30Z", end: "2024-11-03T05:45Z",
	},
	{
		name: "the second occurrence of a repeated interval",
		zone: "America/New_York",
		week: [{ weekday: 7, startMinute: 90, endMinute: 105 }],
		start: "2024-11-03T06:30Z", end: "2024-11-03T06:45Z",
	},
	{
		name: "a continuous repeated hour",
		zone: "America/New_York",
		week: [{ weekday: 7, startMinute: 60, endMinute: 120 }],
		start: "2024-11-03T05:00Z", end: "2024-11-03T07:00Z",
	},
	{
		name: "the second occurrence of midnight",
		zone: "America/Havana",
		week: [{ weekday: 7, startMinute: 0, endMinute: 30 }],
		start: "2024-11-03T05:00Z", end: "2024-11-03T05:30Z",
	},
	{
		name: "a nonexistent midnight",
		zone: "America/Havana",
		week: [{ weekday: 7, startMinute: 0, endMinute: 90 }],
		start: "2024-03-10T05:00Z", end: "2024-03-10T05:30Z",
	},
	{
		name: "a skipped local date",
		zone: "Pacific/Apia",
		week: [{ weekday: 4, startMinute: 1380, endMinute: 1440 }, { weekday: 6, startMinute: 0, endMinute: 60 }],
		start: "2011-12-30T09:30Z", end: "2011-12-30T10:30Z",
	},
	{
		name: "a half-hour offset transition",
		zone: "Australia/Lord_Howe",
		week: [{ weekday: 7, startMinute: 90, endMinute: 120 }],
		start: "2024-04-06T14:30Z", end: "2024-04-06T15:30Z",
	},
])("covers $name", ({ zone, week, start, end }) => {
	expect(isScheduleCovered(week, new Date(start), new Date(end), zone)).toBe(true);
});

it.each([
	{ zone: "America/New_York", startMinute: 90, endMinute: 105, start: "2024-11-03T05:30Z", end: "2024-11-03T06:45Z" },
	{ zone: "America/Havana", startMinute: 0, endMinute: 30, start: "2024-11-03T04:00Z", end: "2024-11-03T05:30Z" },
])("preserves the uncovered gap between repeated intervals in $zone", ({ zone, startMinute, endMinute, start, end }) => {
	expect(isScheduleCovered([{ weekday: 7, startMinute, endMinute }], new Date(start), new Date(end), zone)).toBe(false);
});
