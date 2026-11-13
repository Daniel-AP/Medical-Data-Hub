# Performance report

## Cache measurements

| Workload | Mode | Included samples | Mean (ms) | Median (ms) |
| --- | --- | ---: | ---: | ---: |
| CW1 | direct | 10 | 2.878 | 2.924 |
| CW1 | cached | 10 | 3.619 | 3.295 |
| CW2 | direct | 10 | 4.806 | 4.742 |
| CW2 | cached | 10 | 4.885 | 4.628 |

All 40 requests returned HTTP 200, and all 20 pairs returned equivalent JSON. Direct requests calculated every unit in PostgreSQL. Cached requests accepted all expected Redis units (1 per CW1 request and 14 per CW2 request) and recalculated zero. Direct requests had lower mean and median latency in CW1. In CW2, cached requests had a slightly lower median and a slightly higher mean.

### Measured pairs

Odd pairs ran direct first. Even pairs ran cached first.

| Workload | Pair | Direct (ms) | Cached (ms) |
| --- | ---: | ---: | ---: |
| CW1 | 1 | 2.953 | 3.693 |
| CW1 | 2 | 2.916 | 3.310 |
| CW1 | 3 | 2.736 | 3.075 |
| CW1 | 4 | 3.398 | 3.104 |
| CW1 | 5 | 3.073 | 3.383 |
| CW1 | 6 | 2.858 | 3.298 |
| CW1 | 7 | 2.932 | 3.175 |
| CW1 | 8 | 2.940 | 6.939 |
| CW1 | 9 | 2.615 | 3.292 |
| CW1 | 10 | 2.363 | 2.917 |
| CW2 | 1 | 4.797 | 5.103 |
| CW2 | 2 | 4.773 | 4.476 |
| CW2 | 3 | 4.771 | 7.640 |
| CW2 | 4 | 5.943 | 4.841 |
| CW2 | 5 | 4.457 | 4.328 |
| CW2 | 6 | 4.941 | 4.272 |
| CW2 | 7 | 4.500 | 4.950 |
| CW2 | 8 | 4.458 | 3.985 |
| CW2 | 9 | 4.712 | 4.628 |
| CW2 | 10 | 4.707 | 4.627 |

### Reproduction

Run `npm ci`, start Docker, and run `npm run measure:cache` from the repository root with Node.js 24 or later.

- Both modes used the same 28 unique B-tree indexes installed by the [migrations](../apps/api/prisma/migrations) in the measured revision
- Synthetic seed with 3 clinics, 3 professionals and 18 appointments per clinic, and appointment dates from 2026-11-02 to 2026-11-19. Both modes used the same Clinica Central reception account, SQL role `reception`, and clinic RLS policies
- Consulta general (30 minutes), 2 eligible professionals, and clinic time zone `America/Costa_Rica`. CW1 queried one professional on 2026-11-16. CW2 queried both eligible professionals from 2026-11-16 to 2026-11-22
- Timeouts in ms were 15000 for the HTTP client, 1000 for PostgreSQL connection acquisition, 1000 for locks, 3000 for SQL statements, 2000 for Keycloak HTTP, and 500 for Redis batches. Redis TTL was 300 seconds

Direct requests calculated availability in one authorized PostgreSQL transaction. Cached requests read Redis between two authorized PostgreSQL phases, with definitive validation in the second phase. The API validates cached starts against the calendar's UTC spans for each clinic-local date. The runner primed and verified Redis before timing, warmed up each mode three times per workload, and timed ten sequential pairs per workload from request dispatch through receipt of the full HTTP body, including API authentication. A pair counted when both responses returned HTTP 200, their JSON was equivalent, and the observed cache counts matched the requested modes.

### Latency trade-off

The two-phase design keeps Redis waits outside PostgreSQL transactions and checks the current clinic version and professional eligibility before serving cached slots. A cache hit avoids recalculating availability. On this fixture, cached requests added 0.371 ms to the CW1 median. In CW2, the cached median was 0.114 ms lower and the mean was 0.079 ms higher.
