import type { RequestHandler } from "express";
import { readWeeklySchedule, replaceWeeklySchedule } from "../database/schedules.js";
import type { ScheduleInterval } from "../database/types.js";
import { isUuid } from "../validation.js";

const isScheduleInterval = (value: unknown): value is ScheduleInterval => {

	if(value === null || typeof value !== "object") {
		return false;
	}
	const { weekday, startMinute, endMinute } = value as Record<string, unknown>;
	const hasOtherFields = Object.keys(value).some((field) => field !== "weekday" && field !== "startMinute" && field !== "endMinute");

	return !hasOtherFields && typeof weekday === "number" && Number.isInteger(weekday) && weekday >= 1 && weekday <= 7 &&
		typeof startMinute === "number" && Number.isInteger(startMinute) && startMinute >= 0 &&
		typeof endMinute === "number" && Number.isInteger(endMinute) && endMinute <= 1440 && startMinute < endMinute;

};

export const readWeeklyScheduleHandler: RequestHandler = async (request, response) => {

	const { professionalId } = request.params;
	if(!isUuid(professionalId) || Object.keys(request.query).length !== 0) {
		throw Object.assign(new Error("Invalid weekly schedule request"), { status: 400 });
	}

	const intervals = await readWeeklySchedule(request.authentication!, professionalId);
	response.set("Cache-Control", "no-store").type("json").end(JSON.stringify({ intervals }));

};

export const replaceWeeklyScheduleHandler: RequestHandler = async (request, response) => {

	const { professionalId } = request.params;
	const intervals: unknown = request.body?.intervals;
	const hasOtherFields = Object.keys(request.body ?? {}).some((field) => field !== "intervals");
	if(!isUuid(professionalId) || !Array.isArray(intervals) || !intervals.every(isScheduleInterval) || hasOtherFields) {
		throw Object.assign(new Error("Invalid weekly schedule"), { status: 400 });
	}

	const { conflicts } = await replaceWeeklySchedule(request.authentication!, professionalId, intervals);
	if(conflicts.length > 0) {
		response.status(409).set("Cache-Control", "no-store").json({ error: "Conflict", conflicts });

		return;
	}
	response.status(204).end();

};
