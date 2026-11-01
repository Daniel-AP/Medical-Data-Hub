# Code

- Write identifiers and comments in English
- Use `camelCase` for variables, functions, and properties, `PascalCase` for classes, types, and interfaces, and `kebab-case` for application files and directories
- Use `snake_case` for SQL tables and columns, and `<singular_entity>_id` for dedicated primary keys, preserving composite and shared keys
- Follow [Prettier](.prettierrc.json), [TypeScript](tsconfig.json), and [ESLint](eslint.config.mjs)

# Documentation

- Write concise English with consistent terminology, ASCII punctuation, and relative repository links
- Check the assignment, rubric, accepted decisions, and relevant code before making claims. The assignment is `project-phase-1-oltp.pdf` in the repository root, excluded locally from Git. Ask for it if unavailable
- Preserve `RF1` through `RF21` and `I1` through `I8`. Distinguish requirements, proposals, accepted decisions, implementation, and verified results. Report discrepancies and unknowns
- Keep credentials, tokens, and real patient data out of documentation and evidence. Use synthetic data
- Keep [design.md](docs/design.md) aligned with decisions and implementation. Preserve its organization and keep the dictionary, ER diagram, and normalization together in Data Model. Record alternatives, tradeoffs, and unresolved decisions without duplicating evidence
- Mention unit tests when appropriate to the work. After writing and validating tests by running them, update [test-report.md](docs/test-report.md) in the same task
- Use a coverage table with only `Requirement` and `Tests` columns, ordered from `RF1` through `RF21`, then `I1` through `I8`. Add rows as coverage becomes available, without empty or `Pending` rows. Each test reference uses its exact name linked to its file through a relative path, line numbers are optional
- Distinguish unit tests from real Compose integration tests. Keep execution evidence outside the coverage table, and report failures, partial runs, and stale results accurately
- Reserve `docs/performance-report.md` for cache measurements and index evidence in separate sections. Define its format and structure with the human when performance evaluation begins, then create it and link it from the test report. Do not create or populate it beforehand
- Record material AI contributions in the existing [ai-usage.md](docs/ai-usage.md) table, separating agent checks from human validation

# Documentation Review

- Propose documentation edits before applying them unless explicitly requested
- After editing, show an excerpt or diff, link the file, and request explicit human review and approval. Keep changed text pending until confirmed, preserving approvals for unchanged content
- Keep editorial approval, decision acceptance, and technical validation separate. Raise outstanding reviews at related milestones without repeatedly requesting them
