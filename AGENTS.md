# Code

- Write identifiers and comments in English
- Use ES modules with `import` and `export`, and `import type` for type-only imports
- Use `camelCase` for variables, functions, and properties, `PascalCase` for classes, types, and interfaces, and `kebab-case` for application files and directories
- Keep local types in the file that uses them and types shared within a module in its `types.ts`. Infer types from validation schemas and reuse generated persistence types. Place `.d.ts` library augmentations next to the related integration or middleware
- Use `snake_case` for SQL tables and columns, and `<singular_entity>_id` for dedicated primary keys, preserving composite and shared keys
- Follow [Prettier](.prettierrc.json), [TypeScript](tsconfig.json), and [ESLint](eslint.config.mjs)

## User Preferences

These preferences are explicit user instructions.

- Keep code direct and scoped to the accepted [design](docs/design.md) and explicit user decisions. Add checks only for concrete agreed requirements or actual boundary failures. Avoid speculative defensive code, redundant checks, and abstractions without a current need
- Use consistent names and parallel code structures for similar responsibilities, following existing repository patterns so related code is easy to read and navigate. Keep this uniformity without adding unnecessary layers or abstractions
- Keep tests simple, direct, and easy to read. Focus each test on meaningful behavior, use only the setup and assertions it needs, and avoid convoluted helpers, unnecessary mocks, or extra abstraction
- Use Prettier as the authority for code formatting. Do not override its output with manual formatting rules
- Prefer single-line expressions when readable. Use multiple lines only when the expression's length or structure requires them, following the configured Prettier width
- Keep branch conditions on one line. Extract longer conditions into clearly named boolean variables before the branch; the boolean expression may span multiple lines only when necessary
- Group statements by meaning: keep related statements together and separate distinct steps with blank lines

# Documentation

- Write concise English with consistent terminology, ASCII punctuation, and relative repository links
- Check the assignment, rubric, accepted decisions, and relevant code before making claims. The assignment is `project-phase-1-oltp.pdf` in the repository root, excluded locally from Git. Ask for it if unavailable
- Preserve `RF1` through `RF21` and `I1` through `I8`. Distinguish requirements, proposals, accepted decisions, implementation, and verified results. Report discrepancies and unknowns
- Keep credentials, tokens, and real patient data out of documentation and evidence. Use synthetic data
- Keep [design.md](docs/design.md) aligned with decisions and implementation. Preserve its organization and keep the dictionary, ER diagram, and normalization together in Data Model. Record alternatives, tradeoffs, and unresolved decisions without duplicating evidence
- Mention unit tests when appropriate to the work. After writing and validating tests by running them, update [test-report.md](docs/test-report.md) in the same task
- Keep [test-report.md](docs/test-report.md) limited to the coverage table. Do not add headings, prose, execution evidence, review notes, or any other content to that file
- Use a coverage table with only `Requirement` and `Tests` columns, ordered from `RF1` through `RF21`, then `I1` through `I8`. Add rows as coverage becomes available, without empty or `Pending` rows. Each test reference uses its exact name linked to its file through a relative path, line numbers are optional
- Distinguish unit tests from real Compose integration tests. Report execution evidence, failures, partial runs, and stale results accurately in chat, never in the test report
- Reserve `docs/performance-report.md` for cache measurements and index evidence in separate sections. Define its format and structure with the human when performance evaluation begins, then create it and link it from the test report. Do not create or populate it beforehand
- Record material AI contributions in the existing [ai-usage.md](docs/ai-usage.md) table, separating agent checks from human validation

# Documentation Review

- Propose documentation edits before applying them unless explicitly requested
- After editing, show a concise excerpt or diff and link the file. Do not add approval-status labels, pending-review notes, or boilerplate approval requests to documents or chat
- Keep accepted design decisions and verified technical results distinct from editorial changes
