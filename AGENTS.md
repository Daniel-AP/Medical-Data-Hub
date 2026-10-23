# Code Conventions

- Write code identifiers and comments in English
- Use `camelCase` for variables, functions, and properties, `PascalCase` for classes, types, and interfaces, and `kebab-case` for application filenames and directories
- Use `snake_case` for SQL tables and columns
- Name dedicated primary keys after the singular entity followed by `_id`, preserve composite and shared keys without adding identifiers solely for naming uniformity
- Follow [Prettier](.prettierrc.json), [TypeScript](tsconfig.json), and [ESLint](eslint.config.mjs) configuration

# Documentation

## Sources and Accuracy

- Consult the relevant assignment sections, rubric, accepted decisions, and existing documentation, compare with code, schema, migrations, and tests when available
- The assignment is `project-phase-1-oltp.pdf` in the project root and is excluded locally from Git, ask for its location or contents if unavailable before claiming what it requires
- Distinguish assignment requirements, team conventions, proposals, accepted decisions, implemented behavior, and verified results, preserve `RF1` through `RF21` and `I1` through `I8`
- Report discrepancies and unresolved questions explicitly, never invent acceptance, validation, test outcomes, measurements, or guarantees

## Writing Style

- Write project documentation and AGENTS.md in English, including headings, tables, and diagram labels
- Use direct sentences, short paragraphs, consistent terminology, and compact lists or tables, avoid filler, duplication, chat references, and empty sections added for symmetry
- Use plain ASCII punctuation, no semicolons in prose, no final periods in compact lists or table cells, and Ex: for useful examples
- Format technical identifiers as inline code except in data dictionary definitions, preserve the existing format of comparable entries
- Use relative repository links and internal anchors, do not depend on local machine paths or links to the excluded assignment PDF
- Keep shared documentation free of credentials, tokens, and real patient data, use synthetic data for examples and test evidence

## Authorization and Review

- When an update is needed, identify the affected document and section, explain why, and present proposed text before requesting authorization unless the human already explicitly requested the edit
- After an authorized edit, show a concrete excerpt or diff, link the file, and request explicit confirmation that the human reviewed and approves the written changes
- Keep new or corrected text pending review until confirmation, preserve approvals for unchanged content, silence or a change of subject is not approval
- Keep editorial approval separate from decision acceptance and technical validation
- Raise outstanding writing or review needs at the next related milestone and before closing the affected work, respect postponements and do not repeat requests in every message

## docs/design.md

- Propose updates when domain rules, requirement interpretations, the data model, tenant isolation, transactions, identity, authorization, auditing, caching, or index choices change
- Also propose updates when implementation, tests, or measurements contradict the design or expose a relevant limitation
- Record the chosen approach, real alternatives, concrete tradeoffs, and unresolved decisions in the relevant section, explain replacements when accepted decisions change
- Preserve the current organization, including Tech Stack, unless a structural change is explicitly authorized
- Keep the dictionary integrated in Data Model, maintain its fields, types, defaults, keys, relationships, and constraints together with the ER diagram and normalization rationale, do not create a separate dictionary or duplicate decision document
- Distinguish proposed schema from implemented definitions, verify implemented identifiers and SQL types against the applicable migration
- Link to test evidence rather than copying results or measurements into the design

## docs/test-report.md

- Build the report incrementally as tests, requirement mappings, relevant runs, defects, cache measurements, and query plans become available
- Map `RF1` through `RF21` and `I1` through `I8` to stable test references, identify missing or partial coverage and distinguish unit tests from integration tests against the real Compose stack
- Record the tested revision and relevant working-tree differences, environment, fixtures, actual commands, outcomes, and evidence needed to reproduce each run
- Keep planned checks separate from observed results, preserve failures, errors, skips, retries, and partial runs without presenting them as full passes
- Mark affected evidence as stale when code, schema, configuration, or tests change, retain historical results rather than attributing them to the new version
- Use comparable workloads and environments for cache measurements, record timing conditions and repetitions, associate index decisions with concrete queries and PostgreSQL plans
- Keep evidence at stable repository paths or durable URLs, summarize relevant findings and remaining acceptance gaps in Markdown

## docs/ai-usage.md

- Propose a concise entry when AI materially contributes to interpretation, design, implementation, tests, or submitted documentation, group related work rather than logging every interaction
- Maintain the existing task, contribution, human validation, and reference table, distinguish agent checks from human validation and mark unknown or unfinished validation as pending
