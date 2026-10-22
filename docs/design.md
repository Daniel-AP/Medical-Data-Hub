# System Design

## 1. Scope and Domain

### Service Catalog Updates

A service's name, duration, and required specialty may be edited while it has no associated appointments. Once any appointment references it, regardless of state, changing its duration or specialty requires a new service to preserve existing appointments and history (`RF3`, `I4`). Name changes remain permitted for corrections, with an administrative rule against redefining the consultation type.

Only the clinic administrator may deactivate a service in their clinic as part of catalog maintenance (`RF3`). Deactivation blocks new bookings and preserves existing appointments and history. Reserved appointments may still be rescheduled with an inactive service to honor existing commitments.

### Appointment States and Rescheduling

Only reserved appointments are considered active. A reserved appointment may become attended, absent, cancelled, or rescheduled. These four states are final (`RF13`). Rescheduling atomically marks the original appointment as rescheduled and creates a linked reserved appointment, preserving the history (`RF10`). Each replacement has a new appointment identifier and may itself be rescheduled.

Rescheduling preserves the patient and service but may change the date, time, or professional within the same clinic, provided the professional is authorized to provide that service.

### Schedule Blocks and Appointment Conflicts

A schedule block is created only if its interval does not overlap any appointment in the reserved state for the same professional. Otherwise, the request is rejected, the conflicting appointments are reported, and no block record is created. The actor may retry after resolving the conflicts.

This decision preserves `I3` without adding appointment states or pending block records. It departs from `RF6`, which describes creating a block before resolving affected appointments. New bookings may enter before a successful retry.

## 2. Architecture

### Technology Stack

| Technology | Role |
| --- | --- |
| TypeScript | Application language. |
| Express | REST API framework. |
| PostgreSQL | Relational database. |
| Prisma ORM | Data access and migrations. |

## 3. Data Model

Constraints for the appointment replacement relationship remain pending.

## 4. Multi-tenancy

## 5. Transactions and Concurrency

Concurrency control for booking, rescheduling, schedule block creation, and service updates remains pending.

## 6. Identity, Security, and Auditing

## 7. Availability, Caching, and Indexes
