export class OperationOutcomeUnknownError extends Error {
	constructor(cause: unknown) {
		super("Operation outcome unknown", { cause });
	}
}
