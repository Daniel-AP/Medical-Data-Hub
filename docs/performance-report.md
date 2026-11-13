# Performance report

## Cache measurements

| Workload | Mode | Included samples | Mean (ms) | Median (ms) |
| --- | --- | ---: | ---: | ---: |
| CW1 | direct | 10 | 2.974 | 3.113 |
| CW1 | cached | 10 | 3.768 | 3.568 |
| CW2 | direct | 10 | 5.260 | 4.928 |
| CW2 | cached | 10 | 5.179 | 5.209 |

All 40 requests returned HTTP 200, and all 20 pairs returned equivalent JSON. Direct requests calculated every unit in PostgreSQL. Cached requests accepted all expected Redis units (1 per CW1 request and 14 per CW2 request) and recalculated zero.

### Measured pairs

Odd pairs ran direct first. Even pairs ran cached first.

| Workload | Pair | Direct (ms) | Cached (ms) |
| --- | ---: | ---: | ---: |
| CW1 | 1 | 3.348 | 3.829 |
| CW1 | 2 | 3.125 | 3.621 |
| CW1 | 3 | 2.933 | 3.735 |
| CW1 | 4 | 3.179 | 3.383 |
| CW1 | 5 | 3.205 | 3.515 |
| CW1 | 6 | 3.294 | 3.649 |
| CW1 | 7 | 3.101 | 3.274 |
| CW1 | 8 | 2.651 | 6.671 |
| CW1 | 9 | 2.453 | 3.161 |
| CW1 | 10 | 2.454 | 2.838 |
| CW2 | 1 | 4.553 | 4.481 |
| CW2 | 2 | 4.716 | 5.081 |
| CW2 | 3 | 4.483 | 5.337 |
| CW2 | 4 | 5.650 | 5.635 |
| CW2 | 5 | 5.370 | 6.393 |
| CW2 | 6 | 5.519 | 5.511 |
| CW2 | 7 | 4.639 | 5.659 |
| CW2 | 8 | 7.812 | 4.827 |
| CW2 | 9 | 4.888 | 4.713 |
| CW2 | 10 | 4.967 | 4.158 |

### Reproduction

Run `npm ci`, start Docker, and run `npm run measure:cache` from the repository root with Node.js 24 or later.

- Measured revision `15cdea914c2187b313cd2ac924fccfff29e85c88` with a clean source tree
- macOS arm64, Node.js 26.0.0 on the host, Docker Engine 29.9.3, and Compose 5.7.0. The API used Node.js 24.22.3, PostgreSQL 18.6, Redis 8.10.3, and Keycloak 26.8.1
- Both modes used the same 31 B-tree indexes, including the three [availability indexes](../apps/api/prisma/migrations/20261112000000_add_availability_indexes/migration.sql)
- Synthetic seed with 3 clinics, 3 professionals and 18 appointments per clinic, and appointment dates from 2026-11-02 to 2026-11-19. Both modes used the same Clinica Central reception account, SQL role `reception`, and clinic RLS policies
- Consulta general (30 minutes), 2 eligible professionals, and clinic time zone `America/Costa_Rica`. CW1 queried one professional on 2026-11-16. CW2 queried both eligible professionals from 2026-11-16 to 2026-11-22
- Timeouts in ms were 15000 for the HTTP client, 1000 for PostgreSQL connection acquisition, 1000 for locks, 3000 for SQL statements, 2000 for Keycloak HTTP, and 500 for Redis batches. Redis TTL was 300 seconds

Direct requests calculated availability in one authorized PostgreSQL transaction. Cached requests read Redis between two authorized PostgreSQL phases, with definitive validation in the second phase. The API validates cached starts against the calendar's UTC spans for each clinic-local date. The runner primed and verified Redis before timing, warmed up each mode three times per workload, and timed ten sequential pairs per workload from request dispatch through receipt of the full HTTP body, including API authentication. A pair counted when both responses returned HTTP 200, their JSON was equivalent, and the observed cache counts matched the requested modes.

### Latency trade-off

The two-phase design keeps Redis waits outside PostgreSQL transactions and checks the current clinic version and professional eligibility before serving cached slots. A cache hit avoids recalculating availability. On this fixture, the cached median was 0.455 ms higher for CW1 and 0.281 ms higher for CW2. The cached mean was 0.794 ms higher for CW1 and 0.081 ms lower for CW2.
