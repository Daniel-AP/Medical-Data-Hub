# Test execution

Install Node.js 24 or newer and start Docker with a Compose version that supports `!override`. From the repository root, run:

```sh
npm run test:all
```

The command installs locked npm dependencies when `node_modules` is absent, generates the Prisma client, and runs the unit tests. It then starts a disposable Compose project using the application migrations, synthetic seed data, and Keycloak realm import. It obtains test tokens from that Keycloak instance and runs the PostgreSQL, API, and Keycloak integration suites in order.

The test project uses settings from `.env.example` and publishes its services on loopback ports. It needs no `.env` file, manual seed data, or pre-issued tokens. The command exits with a nonzero status if preparation or a suite fails and removes the project's containers, volumes, network, and local images on completion or failure.

Use `npm test` to run only the unit suite after installing dependencies and generating the Prisma client. See the [coverage table](test-report.md) for links from the requirements to the tests.
