import { app } from "./app.js";

const host = process.env.HOST;
const port = Number(process.env.PORT);

app.listen({ port, host }, (error) => {

	if (error) {
		console.error(error.message);
		process.exitCode = 1;

		return;
	}

	console.info(`API listening on ${host}:${port}`);

});
