import type { Authentication } from "./types.js";

declare module "express-serve-static-core" {
	interface Request {
		authentication?: Authentication;
	}
}
