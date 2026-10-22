# Design Decisions

| ID | Decision | Status |
| --- | --- | --- |
| ADR-001 | [Reject schedule blocks that conflict with reserved appointments](#adr-001-reject-schedule-blocks-that-conflict-with-reserved-appointments) | Accepted |

## ADR-001: Reject Schedule Blocks That Conflict with Reserved Appointments

**Status:** Accepted

### Decision

Reject a block request if it overlaps a reserved appointment for the same professional. Report the conflicts and create no block record. Allow a retry after resolving them. This preserves `I3` without adding appointment or block states. See [Scope and Domain](design.md#schedule-blocks-and-appointment-conflicts).

### Consequences

- Blocking waits until conflicts are resolved; new bookings may enter before a successful retry.
- This departs from `RF6`, which allows creating the block before resolving conflicts. Instructor acceptance has not been established.
- Conflict checking and block creation must prevent races with booking and rescheduling; the mechanism remains undecided.
