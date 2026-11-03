export {};

declare module "express-serve-static-core" {
	interface Request {
		authentication?: { identityId: string };
	}
}
