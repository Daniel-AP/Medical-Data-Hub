# Documentation

## Language

- Write all content in `AGENTS.md` and all project documentation in English, including headings, prose, tables, and diagram labels.
- Preserve technical identifiers and the assignment's original requirement identifiers (`RF1` through `RF21` and `I1` through `I8`). The English documentation requirement is a team convention; it does not require translating or modifying the original assignment PDF.

## Shared documentation rules

### Sources and accuracy

- Before proposing content, consult the relevant assignment sections, rubric, accepted decisions, and existing documentation. Check against code and migrations when available.
- The assignment requires Markdown documentation; the filenames and structures below are team conventions, not explicit instructor requirements.
- Distinguish assignment requirements, team interpretations, proposed design, accepted decisions, implementation, and verified results. Do not silently resolve ambiguities or invent agreements, tests, measurements, or guarantees.
- The assignment PDF is excluded locally from Git. If unavailable, ask for its location or contents before making claims about its requirements.

### Design readiness before implementation

- Before implementing application behavior or schema migrations, substantially prepare `docs/design.md`, `docs/data-dictionary.md`, and `docs/design-decisions.md`. These must contain an agreed initial design, not just headings or placeholders.
- The initial design must identify scope, domain rules, components and interfaces, the ER model, critical flows, and the chosen approaches to tenant isolation, concurrency, identity, security, and caching.
- The initial dictionary must describe the proposed tables, field meanings, agreed types, keys, relationships, and constraints. Record significant structural choices and unresolved questions in the decision log.
- Detail each component before implementing it. The documents need not be final, but decisions that determine the upcoming implementation must be resolved; unrelated details may remain pending.
- If this preparation is missing, explicitly identify the gaps and recommend documenting and reviewing them before dependent code. Revisit unresolved gaps at the next related milestone; do not silently skip preparation or write documents without authorization.
- Respect an explicit human instruction to proceed despite a documented gap. Do not treat that instruction as acceptance of unspecified design choices. Limited experiments may inform a decision without becoming the accepted implementation.
- Keep the documents current when implementation or tests reveal necessary changes. Do not rewrite them for every function or routine code edit.

### Style and consistency

- Use direct sentences, short paragraphs, and precise technical vocabulary. Preserve technical identifiers and format them as inline code where appropriate.
- Write for someone who understands software engineering but has not read this conversation. Avoid chat references, transcripts, and chronological accounts of the work.
- Remove filler, repeated introductions, promotional language, and restated conclusions. Claims such as "robust," "secure," "efficient," or "scalable" require concrete mechanisms or evidence.
- Keep heading hierarchy, terminology, and equivalent tables consistent. Use diagrams, tables, or prose according to the content; do not create empty subsections to force symmetry.
- Use relative links for repository files and internal anchors for sections. Shared documentation must not depend on local machine paths or links to the Git-excluded assignment PDF.
- Record real alternatives and specific costs. Do not justify a decision solely because it is common practice.
- When an accepted decision changes, identify its replacement and explain why; preserve its reference in the decision log when one exists.

### Human authorization and review

This workflow applies to `docs/design.md`, `docs/design-decisions.md`, `docs/data-dictionary.md`, `docs/test-report.md`, and `docs/ai-usage.md`:

1. When documentation is due, identify what needs recording, the affected section, and why.
2. Do not edit automatically. Present the proposed text and request authorization unless the human has already explicitly requested that edit. Do not request permission again for authorized work.
3. After editing, show a diff or concrete excerpts, link the file, and request explicit confirmation that the human reviewed and approves the written changes.
4. Keep the revised text pending review until confirmation. Corrections require review of the resulting version. Silence or a change of subject is not approval.
5. Keep decision acceptance separate from editorial approval. Pending review of a write-up does not revoke an already accepted design decision; approval of wording alone does not accept a new design proposal.
6. Raise outstanding writing or review needs at the next related milestone and before closing the affected work. Do not repeat requests in every message or create automatic reminders.
7. Respect an explicit postponement. Continue only with work that does not depend on an unresolved design decision or on treating the revised text as approved.

### Review checks

- Preserve approvals for unchanged content. A confirmation must identify the scope reviewed; if unclear, ask for clarification. Never invent approval evidence.
- Before presenting an edit, check assignment coverage, accepted decisions, implementation differences, links, diagrams, formatting, duplication, and unsupported claims. Report discrepancies instead of silently changing the implementation or the accepted design.

## README.md

Do not modify the README during implementation unless explicitly instructed by the human. Complete it at the end. Before drafting it, read the assignment (`project-phase-1-oltp.pdf`, in the project root) to identify the required content, including reproducible instructions for running the system and tests, and the API route contract.

## docs/design.md

### Purpose

- The document must explain the system design and the reasons behind its decisions. It must support teamwork and the technical defense of the solution.

### When to document

- Establish the initial design before implementation according to the readiness rules above, then maintain it throughout development.
- Propose an update whenever a domain rule, assignment interpretation, data model, isolation strategy, transactional flow, security mechanism, or cache mechanism is agreed upon or changed.
- Also propose an update when the implementation, a test, or a measurement contradicts the documented design or reveals a relevant limitation.
- Before implementing a part of the system, check whether its design is documented. If it is missing, identify what needs to be recorded; do not invent decisions to fill the section.
- After completing a part of the system, check that the document describes the implementation. At project completion, review the entire document for consistency and valid references.

### Required structure

Use a single level-one heading: `# System Design`. Keep these seven level-two sections in this order:

1. `## 1. Scope and Domain`: stage boundaries, actors, responsibilities, business rules, appointment states and transitions, assumptions, and relevant ambiguities.
2. `## 2. Architecture`: an overview diagram; responsibilities of the application, relational database, Keycloak, and Redis; communication, dependencies, and data ownership.
3. `## 3. Data Model`: the entity-relationship diagram, relationships and constraints; step-by-step justification of normalization through 3NF; deliberate denormalizations and a reference to the data dictionary.
4. `## 4. Multi-tenancy`: comparison of at least two strategies, a justified choice, and mechanisms that prevent access across clinics and uphold I5.
5. `## 5. Transactions and Concurrency`: booking and rescheduling flows, transaction boundaries, the chosen isolation level, race control, and conflict and deadlock handling.
6. `## 6. Identity, Security, and Auditing`: identity-to-clinic mapping, token validation and authorization, application permissions and at least three database privilege profiles; parameterized queries and database-enforced protection of the append-only audit log.
7. `## 7. Availability, Caching, and Indexes`: availability calculation, Redis keys and entry scope, invalidation policy, the source of truth, and indexes associated with concrete queries, starting with RF7.

Do not add, remove, or reorder these sections without an explicit human instruction or approval. An undeveloped section must briefly identify what remains pending; do not fill it with generic prose.

### Consistency and formatting within sections

- Each section must make its objective and relevant requirements, design, rationale and consequences, and verification approach identifiable. Adapt the depth to the subject; do not repeat entire requirements or create empty subsections merely to imitate uniformity.
- Where appropriate, use the subsection pattern `Objective and Requirements`, `Design`, `Rationale and Consequences`, and `Verification`. Internal headings may vary to better represent the subject. `Verification` must reference tests and evidence without duplicating results from the test report.
- Keep heading hierarchy and terminology consistent throughout the document. Do not alternate names for the same concept. Explain the mapping between domain terms and code identifiers.
- Use tables for comparisons, permissions, and responsibilities; diagrams for architecture, relationships, and states; flows or pseudocode for transactional operations. Do not force the same visual format into every section.
- Keep names, columns, and level of detail consistent across equivalent tables. Diagrams must be editable, legible, and consistent with the prose.
- Reference the original identifiers `RF1` through `RF21` and `I1` through `I8` where relevant. Explain the mechanism that upholds each guarantee rather than merely asserting compliance.

### Document boundaries

- The API route contract and execution instructions belong in the README; column details belong in the data dictionary; results, measurements, and execution plans belong in the test report. Link to them from the design without maintaining complete copies across files.
- The design must contain enough rationale to understand the current solution, even when a separate decision log exists.

## docs/design-decisions.md

### Purpose and recording criteria

- Keep short Architecture Decision Records (ADRs) explaining significant choices and their consequences. This single-file decision log is a team convention, not an additional deliverable required by the assignment.
- Propose an ADR when a choice materially affects system boundaries, data integrity, tenant isolation, transactions, security, caching, or interpretation of a requirement. Do not create records for every class, field, or routine implementation detail.
- Record structural choices before their dependent implementation. Use `Proposed` while discussion remains open; do not reconstruct a favorable justification after implementation or infer agreement from an assistant recommendation.
- Apply the shared authorization, review, and writing rules. Acceptance of a decision and approval of its written record remain separate.

### Structure and formatting

- Use `# Design Decisions` as the title. Follow it with a compact index using `ID | Decision | Status`; link each decision title to its record.
- Use a stable heading such as `## ADR-001: <decision title>` for each record. Assign sequential IDs; do not reuse or renumber them.
- State `Status` beneath the record heading using `Proposed`, `Accepted`, `Rejected`, or `Superseded`. Include replacement references only when applicable.
- Use these baseline subsections within each record:
  - `### Context`: the concrete problem, relevant requirements or invariants, and constraints that make the choice necessary.
  - `### Alternatives`: the options actually considered and their relevant differences. Use a comparison table when useful; do not invent options to fill the template.
  - `### Decision`: the selected approach and the reasons for choosing it, or the specific choice awaiting agreement if still proposed.
  - `### Consequences`: benefits, costs, limitations, risks, and follow-up work that result from the choice. Distinguish expected consequences from measured outcomes.
- Keep the same subsection order and comparable detail across records. Adapt internal formatting only when the content requires it; avoid transcripts, repeated introductions, and generic advantages.

### Lifecycle and document boundaries

- Mark a decision `Accepted` only after explicit human agreement on the choice. Rejection of a proposal changes its status to `Rejected`; it does not become an accepted alternative.
- Preserve the substance and original rationale of accepted records. When a decision is materially replaced, add a new ADR, mark the previous one `Superseded`, and link both records. Editorial corrections do not require a new ADR.
- Keep the current design in `docs/design.md` and field definitions in `docs/data-dictionary.md`. Link ADRs from affected sections instead of copying entire discussions or comparison tables between documents.
- Keep assignment-required explanations in the design document, including the multi-tenancy comparison and isolation rationale. An ADR must not replace those required contents.
- Before presenting an edit, check stable IDs, decision statuses, links to affected design sections, and consistency with accepted choices. Reference supporting implementation or test evidence when available; do not imply that acceptance proves implementation or correctness.

## docs/data-dictionary.md

### Purpose and maintenance

- Describe the structure and meaning of the relational data. Cover the assignment's domain entities and the actual tables, including junction tables; do not assume one table per domain entity.
- Write incrementally. Propose updates when fields, types, defaults, allowed values, keys, relationships, or constraints are agreed upon or changed, or when implementation differs from the documentation.
- Check definitions against accepted decisions, the ER diagram, and migrations when available. Mark unresolved definitions as pending; do not invent schema details or modify the implementation to match the document without authorization.
- Explain what each field means; do not merely restate its name. Justify non-obvious attributes briefly or link to the relevant design decision.

### Structure and consistent formatting

Use `# Data Dictionary` as the document title and the following baseline structure:

1. `## 1. Scope and Conventions`: schema coverage, implemented migration baseline when available, notation, and conventions for missing values.
2. `## 2. Shared Domains`: allowed values and their meanings, shared units, and date and time conventions. Define shared information once and reference it from field entries.
3. `## 3. Table Catalog`: a linked inventory of physical table names, purposes, and global or clinic-specific scope.
4. `## 4. Table Definitions`: one entry per table using the pattern below.
5. `## 5. Pending Items`: unresolved definitions and schema discrepancies, with references to the affected entries.

- Adapt the internal structure only when the information requires it. Preserve comparable headings, terminology, column order, and detail across equivalent entries. Consistency must not force unrelated content into identical layouts.
- Split a table or add a focused subsection when needed for readability. Do not add empty subsections or generic text to imitate symmetry.

### Table entry pattern

- Use a heading with the proposed name or exact implemented table name, including its schema when applicable.
- Introduce the table with its purpose, what one row represents, tenant scope, and `Schema Status`: `Proposed` or `Implemented`. For mixed entries, label proposed fields or constraints individually.
- Under `Columns`, use the baseline columns `Column | SQL Type | Nullable | Default | Meaning`.
- Under `Keys, Relationships, and Constraints`, use `Name | Kind | Columns | Rule or Reference | Enforcement`. Separate constraint types into consistent tables if their details do not fit this layout clearly.
- Add `Special Semantics` only when needed for field-specific behavior, sensitive fields, derived values, or exceptions not already covered by shared conventions.

### Accuracy and quality checks

- For implemented definitions, preserve exact identifiers and declared SQL types, including length, precision, and scale where applicable; use schema declaration order. Reference the applicable migration baseline.
- For proposed definitions, record agreed choices and mark unresolved names or types `TBD`. Do not invent physical details before the database design is agreed. Keep schema status separate from decision acceptance and editorial approval.
- Distinguish SQL `NULL`, an empty string, and the absence of a declared default. State units and the meaning of missing values where relevant.
- Document primary, foreign, composite, and unique keys; uniqueness scope; checks; referenced columns; and declared update and delete actions. Do not describe individual columns as independently unique when only their combination is unique.
- Distinguish database enforcement, application validation, and proposed rules. Do not claim a foreign key alone guarantees tenant isolation without verifying the relevant columns and constraints.
- Identify clinical and contact fields that need special handling. Use synthetic examples only when they clarify a definition.
- Link to the ER diagram, normalization rationale, security design, and test evidence rather than duplicating them. Keep definitions understandable without reproducing entire DDL scripts.
- Before presenting an edit, check coverage, agreement with the schema and accepted design, valid references, consistent formatting, and explicit pending items.

## docs/test-report.md

### Purpose and maintenance

- Report what was tested, on which revision, what happened, and what remains unverified. The report must let the evaluator reproduce the evidence and trace it to assignment requirements.
- Build the report incrementally. Propose updates when tests or requirement mappings change, a relevant run completes, a defect is found or resolved, or cache measurements and execution plans become available.
- Keep planned checks separate from observed results. Before execution, record coverage intentions and gaps without invented counts, timings, commands, or successful outcomes.
- Link results to their tested revision, including relevant uncommitted changes. If code, schema, configuration, or tests change, identify affected evidence as stale until rerun; do not overwrite historical results as though they tested the new version.
- Apply the shared human authorization, review, and writing rules. Editorial approval does not make a test pass or establish acceptance of the system.

### Structure and consistent formatting

Use `# Test Report` as the title and the following baseline sections:

1. `## 1. Scope and Acceptance Criteria`: unit and integration scope, relevant risks, and an internal link to the acceptance checklist in `Execution Summary`. Do not add Stage 2 load testing or the three-person module as requirements for this two-person team.
2. `## 2. Environment and Reproduction`: run identifier, execution date and time with timezone, tested revision and working-tree differences, relevant runtime and service versions, configuration, and fixture or seed baseline. Record the actual test command and automated setup or reset needed for that run; link general operating instructions when available.
3. `## 3. Requirements Traceability`: mappings for every `RF1` through `RF21` and `I1` through `I8`, including missing or partial coverage. An existing test mapping is not proof that the requirement passes.
4. `## 4. Execution Summary`: the selected run's unit and integration totals, outcomes, duration, exit status, and evidence references. Identify partial runs. Include a table using `Acceptance Check | Outcome | Evidence`, briefly summarizing all seven assignment checks in their original order. Reference this table elsewhere instead of repeating the checklist or linking to the excluded PDF.
5. `## 5. Critical Scenario Evidence`: reproducible evidence for the appointment lifecycle, authorization, tenant isolation, concurrency, audit protection, and cache consistency. Reference tests instead of transcribing their implementation.
6. `## 6. Cache Measurements and Index Plans`: the before-and-after cache comparison and the query plans used to justify indexes, starting with RF7.
7. `## 7. Open Issues and Acceptance Assessment`: uncovered requirements, failures, blocked or unstable tests, deviations, residual risks, and the evidence-based acceptance assessment. Link issue details or describe concrete reproduction steps and impact.

- Adapt internal headings and tables when the content requires it. Keep equivalent scenarios, runs, measurements, and issue entries consistent in names, ordering, units, and detail. Do not force unrelated evidence into the same layout.
- Use baseline traceability columns `Requirement | Test Reference | Level | Coverage Notes`. Use exact test names or stable IDs with repository links; explain the assertion that supports each mapping.
- Use baseline result columns `Suite | Passed | Failed | Errors | Skipped | Duration | Evidence`. Report blocked and unexecuted checks separately; they are not successful test executions.
- For a critical scenario, identify setup, action, expected outcome, observed outcome, run, and evidence. Use short prose or tables; add detail only where needed to explain the guarantee or a failure.

### Required evidence

- Show that unit tests isolate logic and integration tests exercise the API against the real Compose stack. Do not present mocked services as real-stack integration evidence.
- Map at least one automated test to each invariant. Include positive behavior and relevant rejection or boundary cases; do not substitute a code-coverage percentage for requirement coverage.
- Include fresh-start evidence for the prescribed Compose startup and a single documented command for unit and integration tests, with scripted data preparation and no manual fixture setup.
- For identity and authorization, include invalid or missing token rejection (`401`), insufficient-role rejection (`403`), and authorized success. For tenant isolation, include deliberate identifier and query-parameter manipulation across clinics.
- For the booking race, record the initial last-slot fixture, how two clients are synchronized, both outcomes, and the persisted result proving exactly one booking and no overlap. Record repetitions if performed; do not claim reproducibility from sequential requests or conceal intermittent failures.
- Include atomic rescheduling, immediate slot release, invalid state-transition rejection, and evidence for conflict and deadlock handling, or identify the remaining coverage gaps.
- For auditing, include sensitive reads and writes and attempts to update or delete audit records using application database privileges; distinguish API checks from database-enforced protection.
- For cache consistency, show availability query, successful booking, and immediate re-query without waiting for TTL expiry. Establish that the scenario exercises caching and checks the relational state rather than merely bypassing Redis.

### Measurements, artifacts, and reporting accuracy

- Compare cache-disabled and cache-enabled behavior using the same workload, dataset, and environment. Record cache warm-up, hit or miss conditions, repetitions, timing boundaries, units, and the statistic reported. Keep measured performance separate from correctness evidence; report regressions honestly.
- For each justified index, identify the query, parameters, dataset size, index definition or migration, plan command, plan artifact, and what the plan demonstrates. Distinguish optimizer estimates from actual execution measurements; do not assume index usage proves improvement.
- Use the chosen database's plan tools. If using PostgreSQL, distinguish `EXPLAIN` from `EXPLAIN ANALYZE`; do not prescribe PostgreSQL before the database choice is accepted.
- Store evidence in a stable repository location or durable artifact URL, with a run identifier. Link full output and include only relevant excerpts in Markdown. Generated runner output may supplement the report; it does not replace the required Markdown explanation.
- Preserve runner totals and outcome distinctions. Explain expected failures, skips, setup errors, and retries; a later pass does not erase an earlier failure. Never combine unrelated runs into an apparent full passing run.
- Use synthetic patient data and redact tokens, credentials, and sensitive payloads from shared evidence. Do not require a particular CI provider, runner, or artifact format unless the team has selected it.
- Before proposing completion, reconcile result totals, check mappings and evidence links, identify stale or missing evidence, and assess all acceptance checks. Mark unverified claims explicitly; avoid unsupported statements such as "all requirements are covered" or "the system is production-ready."

## docs/ai-usage.md

### Purpose and recording criteria

- Declare actual AI contributions, the affected work, and the human validation performed, as required by the assignment. Keep the declaration concise and specific.
- Proactively propose an entry when AI materially contributes to requirement interpretation, design, implementation, tests, or submitted documentation. Group related assistance by task; do not log every routine interaction.
- Select entries by relevance to the delivered work. Do not replace actual contributions with a generic list of acceptable AI uses or invent human review and verification.

### Structure and formatting

Use `# AI Usage` as the title and these baseline sections:

1. `## 1. Scope`: briefly identify the tools actually used and the work they assisted with. Describe actual use, not future recording procedures or hypothetical permissions.
2. `## 2. Usage Record`: a compact table using `Task or Deliverable | AI Contribution | Human Validation | Reference`. Identify what was adopted or revised and link relevant files, decisions, or test evidence where available.

- Record performed and pending validation in the corresponding table row; do not repeat it in a separate section. Review procedures belong in `AGENTS.md`, not in the declaration.
- Keep entries comparable in wording and detail. Adapt the layout only when the content requires it; avoid transcripts, prompt dumps, repeated disclaimers, and generic claims of responsible use.

### Accuracy checks

- Distinguish checks performed by the agent from checks performed by humans. Identify source comparison, design review, code inspection, or executed tests only when they actually occurred.
- Human approval of the entry's wording does not prove that its claimed technical validation occurred. Ask for clarification when the validation is unknown; label it pending rather than inferring it.
- Before submission, reconcile the declaration with the relevant contributions and artifacts. Keep references accessible and exclude credentials, tokens, and real patient data.
