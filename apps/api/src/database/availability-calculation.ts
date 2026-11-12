import { createLocalTimeReader } from "./schedule-coverage.js";
import type { ScheduleInterval } from "./types.js";

type Interval = { start: number; end: number };
type LocalDateSpan = Interval & { midnight: number; offset: number; weekday: number };
type LocalTimeReader = ReturnType<typeof createLocalTimeReader>;
type AvailabilityCalendar = {
	dates: Map<number, string>;
	spans: LocalDateSpan[];
	readLocalTime: LocalTimeReader;
};
type DailyAvailability = { localDate: string; starts: string[] };
type AvailabilityTimeReference = { today: string; instant: number };

const minuteMs = 60_000;
const dayMs = 1440*minuteMs;

const readDateSpan = (start: number, limit: number, readLocalTime: LocalTimeReader): LocalDateSpan => {

	const { date, offset } = readLocalTime(start);
	const weekday = date.getUTCDay() || 7;
	const midnight = date.setUTCHours(0, 0, 0, 0);
	let end = Math.min(limit, midnight+dayMs-offset);

	// IANA offset changes are separated by more than one day.
	if(readLocalTime(end-1).offset !== offset) {

		let before = start;
		while(end-before > 1) {

			const middle = Math.floor((before+end)/2);
			if(readLocalTime(middle).offset === offset) {
				before = middle;
			} else {
				end = middle;
			}

		}

	}

	return { start, end, midnight, offset, weekday };

};

export const prepareAvailabilityCalendar = (from: string, to: string, timeZone: string): AvailabilityCalendar => {

	const firstDay = Date.parse(from);
	const lastDay = Date.parse(to);
	const dates = new Map<number, string>();
	for(let day = firstDay; day <= lastDay; day += dayMs) {
		dates.set(day, new Date(day).toISOString().slice(0, 10));
	}

	const readLocalTime = createLocalTimeReader(timeZone);
	const spans: LocalDateSpan[] = [];
	// Pad the search by a UTC day on each side to account for zone offsets.
	const limit = lastDay+2*dayMs;
	for(let start = firstDay-dayMs; start < limit;) {
		const span = readDateSpan(start, limit, readLocalTime);
		spans.push(span);
		start = span.end;
	}
	const first = spans.findIndex((span) => dates.has(span.midnight));
	const last = spans.findLastIndex((span) => dates.has(span.midnight));

	return { dates, spans: first === -1 ? [] : spans.slice(first, last+1), readLocalTime };

};

const mergeIntervals = (intervals: Interval[]) => {

	const merged: Interval[] = [];
	for(const interval of intervals.sort((left, right) => left.start-right.start)) {

		const previous = merged.at(-1);
		if(previous && interval.start <= previous.end) {
			previous.end = Math.max(previous.end, interval.end);
		} else {
			merged.push(interval);
		}

	}

	return merged;

};

export const getOccupationWindows = (calendar: AvailabilityCalendar, durationMinutes: number) => {

	const windows: Interval[] = [];
	for(const span of calendar.spans) {

		if(!calendar.dates.has(span.midnight)) {
			continue;
		}
		const first = Math.ceil(span.start/minuteMs)*minuteMs;
		const last = (Math.ceil(span.end/minuteMs)-1)*minuteMs;
		if(first <= last) {
			windows.push({ start: first, end: last+durationMinutes*minuteMs });
		}

	}

	return mergeIntervals(windows);

};

const projectSchedule = (weeklyCoverage: Interval[], span: LocalDateSpan) => {

	const weekStart = span.midnight-(span.weekday-1)*dayMs-span.offset;
	const coverage: Interval[] = [];
	for(const interval of weeklyCoverage) {

		const start = Math.max(span.start, weekStart+interval.start);
		const end = Math.min(span.end, weekStart+interval.end);
		if(start < end) {
			coverage.push({ start, end });
		}

	}

	return coverage;

};

const expandSchedule = (week: readonly ScheduleInterval[], calendar: AvailabilityCalendar, durationMs: number) => {

	const weeklyCoverage = mergeIntervals(week.map(({ weekday, startMinute, endMinute }) => {
		const dayStart = (weekday-1)*dayMs;

		return { start: dayStart+startMinute*minuteMs, end: dayStart+endMinute*minuteMs };
	}));
	const schedule = mergeIntervals(calendar.spans.flatMap((span) => projectSchedule(weeklyCoverage, span)));
	const lastSpan = calendar.spans.at(-1);
	const tail = schedule.at(-1);
	if(!lastSpan || tail?.end !== lastSpan.end) {
		return schedule;
	}

	const lastStart = (Math.ceil(lastSpan.end/minuteMs)-1)*minuteMs;
	const limit = lastStart+durationMs;
	const coversWholeWeek = weeklyCoverage[0].start === 0 && weeklyCoverage[0].end === 7*dayMs;
	if(coversWholeWeek) {
		tail.end = Math.max(tail.end, limit);

		return schedule;
	}

	// Only coverage connected to the requested dates can complete an overnight candidate.
	while(tail.end < limit) {

		const span = readDateSpan(tail.end, limit, calendar.readLocalTime);
		const [coverage] = projectSchedule(weeklyCoverage, span);
		if(coverage?.start !== tail.end) {
			break;
		}
		tail.end = coverage.end;

	}

	return schedule;

};

const subtractOccupation = (schedule: Interval[], occupation: Interval[]) => {

	const free: Interval[] = [];
	let index = 0;
	for(const { start, end } of schedule) {

		let cursor = start;
		while(index < occupation.length && occupation[index].start < end) {

			const occupied = occupation[index];
			if(cursor < occupied.start) {
				free.push({ start: cursor, end: occupied.start });
			}
			cursor = Math.max(cursor, occupied.end);
			if(cursor >= end) {
				break;
			}
			index++;

		}
		if(cursor < end) {
			free.push({ start: cursor, end });
		}

	}

	return free;

};

export const calculateDailyAvailability = (
	calendar: AvailabilityCalendar,
	week: readonly ScheduleInterval[],
	occupation: readonly { startAt: Date; endAt: Date }[],
	durationMinutes: number,
): DailyAvailability[] => {

	const durationMs = durationMinutes*minuteMs;
	const schedule = expandSchedule(week, calendar, durationMs);
	const occupied = mergeIntervals(occupation.map(({ startAt, endAt }) => ({ start: startAt.getTime(), end: endAt.getTime() })));
	const free = subtractOccupation(schedule, occupied);
	const days = new Map<number, DailyAvailability>();
	for(const [midnight, localDate] of calendar.dates) {
		days.set(midnight, { localDate, starts: [] });
	}

	let index = 0;
	for(const span of calendar.spans) {

		const day = days.get(span.midnight);
		if(!day) {
			continue;
		}
		while(index < free.length && free[index].end <= span.start) {
			index++;
		}
		for(let i = index; i < free.length && free[i].start < span.end; i++) {

			const interval = free[i];
			const first = Math.ceil(Math.max(interval.start, span.start)/minuteMs)*minuteMs;
			const last = interval.end-durationMs;
			for(let start = first; start <= last && start < span.end; start += minuteMs) {
				day.starts.push(new Date(start).toISOString());
			}

		}

	}

	return [...days.values()];

};

export const getAvailabilityTimeReference = (timeZone: string, now: Date): AvailabilityTimeReference => {
	const instant = now.getTime();
	const today = createLocalTimeReader(timeZone)(instant).date.toISOString().slice(0, 10);

	return { today, instant };
};

export const filterFutureStarts = (units: readonly DailyAvailability[], { today, instant }: AvailabilityTimeReference) => {
	return units.map((unit) => unit.localDate === today
		? { ...unit, starts: unit.starts.filter((start) => Date.parse(start) > instant) }
		: unit);
};
