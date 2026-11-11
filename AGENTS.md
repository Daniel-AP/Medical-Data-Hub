# Code

- Write identifiers and comments in English
- Use ES modules with `import` and `export`, and `import type` for type-only imports
- Use arrow functions for standalone functions and callbacks
- Use `camelCase` for variables, functions, and properties, `PascalCase` for classes, types, and interfaces, and `kebab-case` for application files and directories
- Keep local types in the file that uses them and types shared within a module in its `types.ts`. Infer types from validation schemas, reuse generated persistence types, and omit redundant annotations when TypeScript infers the intended type. Place `.d.ts` library augmentations next to the related integration or middleware
- Use `snake_case` for SQL tables and columns, and `<singular_entity>_id` for dedicated primary keys, preserving composite and shared keys
- Follow [TypeScript](tsconfig.json) and [ESLint](eslint.config.mjs)

## User Preferences

These preferences are explicit user instructions.

- Keep code direct and scoped to the accepted [design](docs/design.md) and explicit user decisions. Add checks only for concrete agreed requirements or actual boundary failures. Avoid speculative defensive code, redundant checks, and abstractions without a current need
- Use simple, descriptive names and parallel code structures for similar responsibilities. Follow existing patterns so related code is easy to read and navigate. Keep this uniformity without adding unnecessary layers or abstractions
- Keep tests simple, direct, and easy to read. Keep only cases that add distinct coverage, with the setup and assertions each case needs. Avoid convoluted helpers, unnecessary mocks, and extra abstraction

## Formatting

- Indent with tabs at a width of four columns. Use double quotes for strings and terminate statements with semicolons
- For statement and function blocks with four or more nonblank lines of code, leave one blank line immediately inside each brace. For shorter blocks, leave neither blank line. Exclude the enclosing braces from the count
- Leave a blank line before each `return` unless it is the only line of code in its block
- Omit spaces around arithmetic and bitwise operators, as in `a+b` and `flags&mask`. Keep spaces around comparison, equality, and logical operators, as in `a === b` and `ready && valid`
- Write `if(condition)`, `else if(condition)`, `for(...)`, and `while(condition)` without a space before the opening parenthesis
- Put spaces inside nonempty braces that open and close on the same line, as in `{ port, host }`, `import { app }`, and `{ return value; }`
- Keep expressions on one line when readable. Wrap them when their length or structure makes multiple lines clearer
- Keep branch conditions on one line. Extract longer conditions into clearly named boolean variables before the branch. Wrap the boolean expression only when necessary
- Group statements by meaning. Keep related statements together and separate distinct steps with blank lines
- Review edited code against these conventions and run the applicable TypeScript and ESLint checks

# Documentation

- Keep [README.md](README.md) limited to its main project title. Do not edit it unless explicitly requested by the human. Include this rule in continuation and handoff prompts
- Write concise English with consistent terminology, ASCII punctuation, and relative repository links
- Check the assignment, rubric, accepted decisions, and relevant code before making claims. The assignment is `project-phase-1-oltp.pdf` in the repository root, excluded locally from Git. Ask for it if unavailable
- Preserve `RF1` through `RF21` and `I1` through `I8`. Distinguish requirements, proposals, accepted decisions, implementation, and verified results. Report discrepancies and unknowns
- Keep credentials, tokens, and real patient data out of documentation and evidence. Use synthetic data
- Update [design.md](docs/design.md) only when the agreed design changes. Preserve its organization and keep the dictionary, ER diagram, and normalization together in Data Model. Record alternatives, tradeoffs, and unresolved decisions without duplicating evidence
- Mention unit tests when appropriate to the work. After writing and validating tests by running them, update [test-report.md](docs/test-report.md) in the same task
- Keep [test-report.md](docs/test-report.md) limited to the coverage table. Do not add headings, prose, execution evidence, review notes, or any other content to that file
- Use a coverage table with only `Requirement` and `Tests` columns, ordered from `RF1` through `RF21`, then `I1` through `I8`. Add rows as coverage becomes available, without empty or `Pending` rows. Each test reference uses its exact name linked to its file through a relative path, line numbers are optional
- Distinguish unit tests from real Compose integration tests. Report execution evidence, failures, partial runs, and stale results accurately in chat, never in the test report
- Reserve `docs/performance-report.md` for cache measurements and index evidence in separate sections. Define its format and structure with the human when performance evaluation begins, then create it and link it from the test report. Do not create or populate it beforehand
- Record material AI contributions in the existing [ai-usage.md](docs/ai-usage.md) table, separating agent checks from human validation. Add a new entry only after the human explicitly approves that entry

# Documentation Review

- Propose documentation edits before applying them unless explicitly requested
- After editing, show a concise excerpt or diff and link the file. Do not add approval-status labels, pending-review notes, or boilerplate approval requests to documents or chat
- Keep accepted design decisions and verified technical results distinct from editorial changes
