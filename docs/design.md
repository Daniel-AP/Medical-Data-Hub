# System Design

## 1. Scope and Domain

### Service Catalog Updates

A service's name, duration, and required specialty may be edited while it has no associated appointments. Once any appointment references it, regardless of state, changing its duration or specialty requires a new service to preserve existing appointments and history (`RF3`, `I4`). Name changes remain permitted for corrections, with an administrative rule against redefining the consultation type.

Only the clinic administrator may deactivate a service in their clinic as part of catalog maintenance (`RF3`). Deactivation blocks new bookings and preserves existing appointments and history. Reserved appointments may still be rescheduled with an inactive service to honor existing commitments.

### Appointment States and Rescheduling

Only reserved appointments are considered active. A reserved appointment may become attended, absent, cancelled, or rescheduled. These four states are final (`RF13`). Rescheduling atomically marks the original appointment as rescheduled and creates a linked reserved appointment, preserving the history (`RF10`). Each replacement has a new appointment identifier and may itself be rescheduled.

Rescheduling preserves the patient and service but may change the date, time, or professional within the same clinic, provided the professional is authorized to provide that service.

Booking and rescheduling allow any future start time aligned to a whole minute. Appointment intervals use `[start, end)`, so consecutive appointments do not overlap (`I1`, `I2`).

### Schedule Changes and Appointment Conflicts

A schedule block is created only if its interval does not overlap any appointment in the reserved state for the same professional. Otherwise, the request is rejected, the conflicting appointments are reported, and no block record is created. The actor may retry after resolving the conflicts.

Weekly schedule changes that leave reserved appointments outside the proposed hours are also rejected, with conflicts reported and no changes applied (`RF5`, `I3`). The affected appointments must first be rescheduled or cancelled.

These rules preserve `I3` without adding appointment states or pending block records. Rejecting conflicting blocks departs from `RF6`, which describes creating a block before resolving affected appointments. New bookings may enter before a successful retry.

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

### Database per Clinic

This comparison considers a separate database for each clinic within a single PostgreSQL instance. Deployments across multiple PostgreSQL instances are outside the scope of this comparison. They would require separate management of server configuration, startup, updates, and recovery.

#### Data Isolation

Each clinic would have a separate database containing its patients, appointments, and clinical notes. A PostgreSQL connection selects one database when it opens. Ordinary SQL queries on that connection cannot directly access tables in another database. For example, omitting a clinic filter while querying clinic A's patients would not include patients stored in clinic B's database.

Access would also require restricted database roles. In PostgreSQL, a role is an account or group of permissions managed by the database engine. Separating databases does not prevent an account from connecting to another clinic's database if its permissions allow it. The credentials used for clinic A would need access only to A's database and permitted operations.

The backend would still need to select the database from the authenticated user's clinic association. If it holds credentials for multiple clinics and selects clinic B's connection for a request from clinic A, database separation alone would not prevent the resulting disclosure.

#### Implementation Complexity

The application could reuse the same data model and appointment logic across clinics, but it would need to manage connections to different databases. PostgreSQL has a supervisor process that listens for incoming connections and starts a dedicated server process for each connection. During connection startup, the application sends the database name and database user, and PostgreSQL checks authentication and access before accepting queries. The resulting session, meaning the interaction over that connection, stays associated with the selected database. Its server process executes SQL commands and returns results over the same connection. It can serve many successive queries, but the session cannot switch to another database.

A connection pool keeps established connections open and lends them to application operations instead of opening a new connection for every request. Returning a connection to the pool leaves its PostgreSQL session and server process running for reuse. With a database per clinic, a connection opened for clinic A cannot be reassigned to clinic B. The data access layer would need to select an available connection for the requested clinic's database or open one if necessary. Each clinic could have multiple connections, so the server processes would correspond to open connections rather than to clinics.

Registering a clinic would require an automated setup process that creates its database, installs the tables and constraints, configures access permissions, and creates its first administrator. Preparing the database structure could reuse migration scripts, which define changes to tables and other database objects. The additional implementation work would be coordinating these steps for each new clinic.

The setup process would also need to handle partial failures. PostgreSQL does not allow `CREATE DATABASE` inside a transaction block, so database creation and the subsequent setup cannot be rolled back together as one operation. For example, if creating the tables fails after the database has been created, the database remains. The application would need a defined way to retry or clean up incomplete setup without reporting the clinic as ready.

#### Operations and Maintenance

Changes to tables, constraints, and indexes would need to be applied to every clinic's database. The same migration scripts could be reused, but their execution and results would need to be tracked separately for each database. If a migration succeeds for clinic A and fails for clinic B, the databases could temporarily have different structures. Deployments would therefore need to account for incomplete migrations before application code starts relying on the new structure.

Separate databases would allow a clinic's data to be exported and restored individually. PostgreSQL's `pg_dump` creates a logical export, meaning a representation of the database's structure and data rather than a copy of its underlying storage files. This would allow clinic A's database to be reconstructed without replacing clinic B's data.

Database separation would not make server maintenance independent for each clinic within the shared PostgreSQL instance. Restarting that instance would interrupt connections for all clinics. Recovery from physical backups also has a shared scope. Restoring a physical backup and replaying the WAL to a selected point in time restores the whole instance, rather than only one clinic's database.

#### Resource Usage and Performance

Keeping connections open for several clinics would consume resources even when some clinics have no active requests. Each connection retains a PostgreSQL server process with its own memory and occupies a slot within `max_connections`. Connection pools would therefore need to be sized against the shared instance's capacity.

Each database would have its own tables, indexes, and system catalogs, which are PostgreSQL's internal tables describing database objects. An appointment index in clinic A's database would contain entries only for A's appointments, allowing its queries and indexes to be tuned independently. However, smaller individual indexes do not establish a performance advantage over shared tables with appropriate indexes. The potential benefit is relevant to the comparison, but its practical significance cannot be established without execution plans and measurements using equivalent data and queries.

All clinic databases would still compete for the instance's CPU, memory, and storage throughput. PostgreSQL's `shared_buffers`, the memory area that caches recently accessed blocks of table and index data, is shared across the instance rather than reserved separately for each clinic. A resource-intensive query in clinic A could therefore slow availability queries in clinic B. Database separation would provide separate data structures without guaranteeing independent performance or a reserved share of server resources.

#### Implications for OLAP

A future OLAP layer would need to treat each clinic's OLTP database as a separate data source. An extraction process, which reads data from the OLTP databases and transfers it to an OLAP store, could reuse the same logic across databases with matching structures. However, it would need to connect to each database and track extraction results separately. Adding a clinic would also require including its database among the sources. This allows extraction to be scheduled or retried per clinic, but adds coordination as the number of databases grows.

Extracted records would need to retain their clinic of origin. Inside the OLTP system, the database itself identifies which clinic owns the data. That context would need to become explicit when records are copied into a common OLAP store. Identifiers cannot be assumed to be unique across independent databases unless the identifier design guarantees it. The OLAP model would therefore need to preserve clinic ownership and distinguish records from different sources without treating independent patient records as one shared clinical history.

Consolidating data means copying records from several clinics into one OLAP store. Access permissions in that store would need to define who may query the data and which clinics' records they may read. For example, an OLAP query from a user authorized only for clinic A must not return clinic B's appointments. The permissions on the source OLTP databases would not automatically apply to these copies, so the OLAP layer would need to enforce clinic boundaries itself. This would introduce a separate authorization design for OLAP, with additional implementation and testing work.

### Schema per Clinic

#### Data Isolation

#### Implementation Complexity

#### Operations and Maintenance

#### Resource Usage and Performance

#### Implications for OLAP

### Shared Tables with Row-Level Security

#### Data Isolation

#### Implementation Complexity

#### Operations and Maintenance

#### Resource Usage and Performance

#### Implications for OLAP

## 5. Transactions and Concurrency

Concurrency control for booking, rescheduling, weekly schedule changes, schedule block creation, and service updates remains pending.

## 6. Identity, Security, and Auditing

## 7. Availability, Caching, and Indexes
