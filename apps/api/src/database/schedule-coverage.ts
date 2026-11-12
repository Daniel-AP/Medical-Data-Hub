import type { ScheduleInterval } from "./types.js";

export const createLocalTimeReader = (timeZone: string) => {

	const formatter = new Intl.DateTimeFormat("en", {
		timeZone, year: "numeric", month: "2-digit", day: "2-digit",
		hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
	});

	return (instant: number) => {

		const parts = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
		const date = new Date(0);
		date.setUTCFullYear(Number(parts.year), Number(parts.month)-1, Number(parts.day));
		date.setUTCHours(Number(parts.hour), Number(parts.minute), Number(parts.second), 0);

		return { date, offset: date.getTime()-Math.floor(instant/1000)*1000 };

	};

};

export const isScheduleCovered = (week: ScheduleInterval[], startAt: Date, endAt: Date, timeZone: string) => {

	const readLocalTime = createLocalTimeReader(timeZone);
	let cursor = startAt.getTime();
	const end = endAt.getTime();
	while(cursor < end) {

		const local = readLocalTime(cursor);
		const weekday = local.date.getUTCDay() || 7;
		const minute = local.date.getUTCHours()*60+local.date.getUTCMinutes();
		const covering = week.filter((interval) => interval.weekday === weekday && interval.startMinute <= minute && minute < interval.endMinute);
		if(covering.length === 0) {
			return false;
		}

		const endMinute = Math.max(...covering.map((interval) => interval.endMinute));
		const midnight = local.date.setUTCHours(0, 0, 0, 0);
		const intervalEnd = midnight+endMinute*60_000-local.offset;
		const next = Math.min(end, intervalEnd, cursor+60_000);
		const offsetChanged = readLocalTime(next-1).offset !== local.offset;
		// Offset changes can fall between UTC minutes
		cursor = offsetChanged ? Math.min(next, Math.floor(cursor/1000)*1000+1000) : next;

	}

	return true;

};
