import type { readFixtures } from "./fixtures.ts";
import { protocol } from "./samples.ts";
import type { measureWorkload } from "./samples.ts";

type Report = {
	revision: string;
	sourceChanges: string[];
	sourceHash: string;
	startedAt: string;
	host: string;
	versions: Record<string, string>;
	timeouts: Record<string, string>;
	fixtures: Awaited<ReturnType<typeof readFixtures>>;
	workloads: Awaited<ReturnType<typeof measureWorkload>>[];
};

const milliseconds = (value: number | null) => value === null ? "N/A" : value.toFixed(3);

export const renderReport = ({ revision, sourceChanges, sourceHash, startedAt, host, versions, timeouts, fixtures, workloads }: Report) => {

	const { scope, clinics, professionalIds, indexes } = fixtures;
	const lines = [
		"## Cache measurements",
		"",
		"### Reproduction",
		"",
		"Run `npm ci` with Node.js 24 or newer and start Docker with Compose support for `!override`. Run the following command from the repository root.",
		"",
		"```sh",
		"npm run measure:cache",
		"```",
		"",
		"The command prints the Markdown report and removes the containers, volumes, network, and local images for its Compose project.",
		"",
		`- Run started at ${startedAt} (UTC)`,
		`- Git HEAD \`${revision}\``,
		`- Source changes relative to HEAD (${sourceChanges.length ? sourceChanges.map((path) => "\`"+path+"\`").join(", ") : "none"})`,
		`- Source fingerprint (SHA-256) \`${sourceHash}\``,
		`- Runner host ${host}`,
		...Object.entries(versions).map(([name, version]) => `- ${name} ${version}`),
		"",
		"### Fixtures and request parameters",
		"",
		"The fresh Compose project uses the application migrations, synthetic seed, and development Keycloak realm. Both modes use the same reception account, SQL role `reception`, and clinic RLS policies. The setup connection reads fixture and index metadata outside the requests.",
		"",
		`- Clinic ${scope.clinicName} (\`${scope.clinicId}\`), time zone \`${scope.timeZone}\`, availability version \`${scope.version}\` before and after the run`,
		`- Service ${scope.serviceName} (\`${scope.serviceId}\`), duration ${scope.durationMinutes} minutes`,
		`- ${professionalIds.length} eligible professionals (\`${professionalIds.join("\`, \`")}\`)`,
		`- Date anchor ${fixtures.from}, the Monday of the selected professional's first future reserved appointment week for this service`,
		...workloads.map(({ name, path, expectedUnits, preparedCache }) =>
			`- ${name} uses \`GET ${path}\` with ${expectedUnits} expected daily ${expectedUnits === 1 ? "unit" : "units"}. The cache verification accepted ${preparedCache!.accepted} and calculated ${preparedCache!.calculated}.`,
		),
		"",
		"| Clinic | Professionals | Appointments | First appointment date | Last appointment date |",
		"| --- | ---: | ---: | --- | --- |",
		...clinics.map(({ name, professionals, appointments, firstDate, lastDate }) =>
			`| ${name} | ${professionals} | ${appointments} | ${firstDate} | ${lastDate} |`,
		),
		"",
		"### Method",
		"",
		"Direct requests calculate availability in one authorized PostgreSQL transaction. Cached requests prepare candidates in PostgreSQL, read Redis, and validate those candidates in a definitive authorized PostgreSQL transaction. Both use the same running API and database.",
		"",
		`Before timing each workload, one cached request prepares the entries and a second confirms their acceptance through the API. Each mode then receives ${protocol.warmupCount} warm-up requests. The runner executes ${protocol.pairCount} sequential pairs per workload, alternating which mode goes first, starting with direct. A monotonic clock measures each request from dispatch through receipt of the complete response body, including API authentication. JSON parsing, equality checks, and report formatting run after timing.`,
		"",
		`The client timeout is ${protocol.requestTimeoutMs} ms. API timeouts in milliseconds are ${Object.entries(timeouts).map(([name, value]) => `\`${name}\` = ${value}`).join(", ")}. Redis entries use a 300-second TTL.`,
		"",
		"The diagnostic header reports the units accepted from Redis and calculated from PostgreSQL. A pair contributes to both aggregates when both requests return HTTP 200, the JSON bodies are equivalent, and the observed counts confirm the requested modes. Failed requests and excluded pairs remain in the sample table.",
		"",
		"### PostgreSQL indexes present during the run",
		"",
		"Both modes use these index definitions from the same migrated database.",
		"",
		"```sql",
		...indexes.map(({ indexdef }) => indexdef+";"),
		"```",
		"",
		"### Samples",
		"",
		"| Workload | Pair | Order | Requested mode | Duration (ms) | HTTP | Observed mode | Accepted | Calculated | Equivalent JSON | Included | Issue |",
		"| --- | ---: | ---: | --- | ---: | ---: | --- | ---: | ---: | --- | --- | --- |",
	];
	for(const { name, pairs } of workloads) {

		for(const { number, samples, responsesEqual, included, issues } of pairs) {
			for(const [index, sample] of samples.entries()) {
				const { mode, durationMs, status, cacheUsage } = sample;
				const equivalent = responsesEqual === null ? "N/A" : responsesEqual ? "Yes" : "No";
				const issue = issues.join(", ") || "-";
				lines.push(
					`| ${name} | ${number} | ${index+1} | ${mode} | ${milliseconds(durationMs)} | ${status ?? "-"} | ${cacheUsage?.mode ?? "-"} | ${cacheUsage?.accepted ?? "-"} | ${cacheUsage?.calculated ?? "-"} | ${equivalent} | ${included ? "Yes" : "No"} | ${issue} |`,
				);
			}
		}

	}
	for(const { name, pairs } of workloads) {
		for(const { number, samples, included } of pairs) {
			if(!included) {
				lines.push("", `Response evidence for excluded pair ${name}/${number}`, "", "```json", JSON.stringify(samples, null, 2), "```");
			}
		}
	}
	lines.push(
		"",
		"### Aggregates",
		"",
		"| Workload | Mode | Included samples | Mean (ms) | Median (ms) |",
		"| --- | --- | ---: | ---: | ---: |",
	);
	for(const { name, aggregates } of workloads) {
		for(const { mode, count, meanMs, medianMs } of aggregates) {
			lines.push(`| ${name} | ${mode} | ${count} | ${milliseconds(meanMs)} | ${milliseconds(medianMs)} |`);
		}
	}

	return lines.join("\n");

};
