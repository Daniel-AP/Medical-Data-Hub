# AI Usage

| Task or Deliverable | AI Contribution | Human Validation | Reference |
| --- | --- | --- | --- |
| Development tooling setup | Installed development dependencies; configured TypeScript, ESLint, and Prettier; added formatting, linting, and test scripts. Ran tooling checks and temporary execution examples. | Tools and conventions confirmed | [Dependencies and scripts](../package.json), [TypeScript](../tsconfig.json), [ESLint](../eslint.config.mjs), [Prettier](../.prettierrc.json) |
| Multi-tenancy comparison | Researched PostgreSQL capabilities and internals using official documentation, compared the three strategies' benefits and limitations, and helped draft the comparison. | Reviewed and refined the comparison | [Multi-tenancy comparison](design.md#4-multi-tenancy) |
| Table and constraint design | Suggested fields, keys, relationships, and constraints, helped draft the ER diagram, and partially reviewed the model for gaps | Reviewed fields, keys, constraints, and diagram | [Data model](design.md#3-data-model) |
| Normalization review | Clarified 1NF, 2NF, and 3NF, and helped review dependencies and refine the normalization and denormalization explanations | Reviewed concepts and requested clearer explanations | [Normalization](design.md#normalization) |
| Transactions and concurrency design | Compared alternatives and tradeoffs for locking, authorization context, audit consistency, cache coordination, and retries, and helped draft the 14 topics | Discussed alternatives, selected approaches, and reviewed and approved all 14 topics | [Transactions and concurrency](design.md#5-transactions-and-concurrency) |
