export const getTestComposeArguments = (project: string) => [
	"compose", "--project-name", project, "--env-file", ".env.example",
	"-f", "docker-compose.yml", "-f", "infra/testing/compose.yml",
];
