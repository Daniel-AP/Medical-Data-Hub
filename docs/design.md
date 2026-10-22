# System Design

## 1. Scope and Domain

### Schedule Blocks and Appointment Conflicts

A schedule block is created only if its interval does not overlap any appointment in the reserved state for the same professional. Otherwise, the request is rejected, the conflicting appointments are reported, and no block record is created. The actor may retry after resolving the conflicts.

This decision preserves `I3` without adding appointment states or pending block records. It departs from `RF6`, which describes creating a block before resolving affected appointments; instructor acceptance has not been established. See [ADR-001](design-decisions.md#adr-001-reject-schedule-blocks-that-conflict-with-reserved-appointments) for consequences and pending concurrency design.

## 2. Architecture

### Technology Stack

| Technology | Role |
| --- | --- |
| TypeScript | Application language. |
| Express | REST API framework. |
| PostgreSQL | Relational database. |
| Prisma ORM | Data access and migrations. |

## 3. Data Model

## 4. Multi-tenancy

## 5. Transactions and Concurrency

## 6. Identity, Security, and Auditing

## 7. Availability, Caching, and Indexes
