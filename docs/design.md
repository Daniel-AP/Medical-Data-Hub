# 1. Business Rules

## Service Catalog Updates

A service's name, duration, and required specialty may be edited while it has no associated appointments. Once any appointment references it, regardless of state, changing its duration or specialty requires a new service to preserve existing appointments and history (`RF3`, `I4`). Name changes remain permitted for corrections, with an administrative rule against redefining the consultation type.

Only the clinic administrator may deactivate a service in their clinic as part of catalog maintenance (`RF3`). Deactivation blocks new bookings and preserves existing appointments and history. Reserved appointments may still be rescheduled with an inactive service to honor existing commitments.

## Appointment States and Rescheduling

Only reserved appointments are considered active. A reserved appointment may become attended, absent, cancelled, or rescheduled. These four states are final (`RF13`). Rescheduling atomically marks the original appointment as rescheduled and creates a linked reserved appointment, preserving the history (`RF10`). Each replacement has a new appointment identifier and may itself be rescheduled.

Rescheduling preserves the patient and service but may change the date, time, or professional within the same clinic, provided the professional is authorized to provide that service.

Booking and rescheduling allow any future start time aligned to a whole minute. Appointment intervals use `[start, end)`, so consecutive appointments do not overlap (`I1`, `I2`).

## Schedule Changes and Appointment Conflicts

A schedule block is created only if its interval does not overlap any appointment in the reserved state for the same professional. Otherwise, the request is rejected, the conflicting appointments are reported, and no block record is created. The actor may retry after resolving the conflicts.

Weekly schedule changes that leave reserved appointments outside the proposed hours are also rejected, with conflicts reported and no changes applied (`RF5`, `I3`). The affected appointments must first be rescheduled or cancelled.

These rules preserve `I3` without adding appointment states or pending block records. Rejecting conflicting blocks departs from `RF6`, which describes creating a block before resolving affected appointments. New bookings may enter before a successful retry.

# 2. Architecture

## Technology Stack

| Technology | Role |
| --- | --- |
| TypeScript | Application language. |
| Express | REST API framework. |
| PostgreSQL | Relational database. |
| Prisma ORM | Data access and migrations. |

# 3. Data Model

## clinics

### Fields

- clinic_id UUID NOT NULL DEFAULT gen_random_uuid() (PK)
- name VARCHAR(200) NOT NULL
- time_zone VARCHAR(64) NOT NULL -- Named time zone, Ex: America/Costa_Rica, America/Bogota

### Constraints

- CHECK clinics_name_check: name <> ''

## users

### Fields

- user_id UUID NOT NULL DEFAULT gen_random_uuid() (PK)
- identity_id VARCHAR(255) NOT NULL -- Keycloak user ID, no credentials
- clinic_id UUID NULL (FK->clinics.clinic_id) -- NULL only for platform_administrator
- role user_role NOT NULL -- Enum: platform_administrator, clinic_administrator, reception, healthcare_professional
- is_active BOOLEAN NOT NULL DEFAULT TRUE

### Constraints

- UNIQUE users_identity_id_key: (identity_id)
- UNIQUE users_clinic_user_key: (clinic_id, user_id)
- CHECK users_role_clinic_check: clinic_id must be NULL for platform_administrator and NOT NULL for all other roles

## specialties

### Fields

- specialty_id UUID NOT NULL DEFAULT gen_random_uuid() (PK)
- clinic_id UUID NOT NULL (FK->clinics.clinic_id)
- name VARCHAR(100) NOT NULL

### Constraints

- UNIQUE specialties_clinic_specialty_key: (clinic_id, specialty_id)
- CHECK specialties_name_check: name <> ''

## professionals

### Fields

- professional_id UUID NOT NULL DEFAULT gen_random_uuid() (PK)
- clinic_id UUID NOT NULL (FK->clinics.clinic_id)
- user_id UUID NOT NULL (FK: (clinic_id, user_id) -> users(clinic_id, user_id))
- specialty_id UUID NOT NULL (FK: (clinic_id, specialty_id) -> specialties(clinic_id, specialty_id))

### Constraints

- UNIQUE professionals_clinic_professional_key: (clinic_id, professional_id)
- UNIQUE professionals_user_key: (clinic_id, user_id)

## services

### Fields

- service_id UUID NOT NULL DEFAULT gen_random_uuid() (PK)
- clinic_id UUID NOT NULL (FK->clinics.clinic_id)
- name VARCHAR(200) NOT NULL
- duration_minutes INTEGER NOT NULL
- specialty_id UUID NOT NULL (FK: (clinic_id, specialty_id) -> specialties(clinic_id, specialty_id))
- is_active BOOLEAN NOT NULL DEFAULT TRUE

### Constraints

- UNIQUE services_clinic_service_key: (clinic_id, service_id)
- CHECK services_name_check: name <> ''
- CHECK services_duration_check: duration_minutes > 0

## professional_services

### Fields

- PK: (clinic_id, professional_id, service_id)
- clinic_id UUID NOT NULL (FK->clinics.clinic_id)
- professional_id UUID NOT NULL (FK: (clinic_id, professional_id) -> professionals(clinic_id, professional_id))
- service_id UUID NOT NULL (FK: (clinic_id, service_id) -> services(clinic_id, service_id))

### Constraints


# 4. Multi-tenancy

All three strategies would require reviewing access permissions for the future OLAP layer. Existing identities, roles, and clinic access rules could be reused. Consolidating data means copying records from several clinics into a common OLAP store. Permissions on the source OLTP data would not automatically protect copies in another store, so access would need to be configured and verified there. The extent of additional authorization work would depend on the OLAP architecture and access requirements.

## Database per Clinic

This comparison considers a separate database for each clinic within a single PostgreSQL instance. Deployments across multiple PostgreSQL instances are outside the scope of this comparison. They would require separate management of server configuration, startup, updates, and recovery.

### Data Isolation

Each clinic would have a separate database containing its patients, appointments, and clinical notes. A PostgreSQL connection selects one database when it opens. Ordinary SQL queries on that connection cannot directly access tables in another database. For example, omitting a clinic filter while querying clinic A's patients would not include patients stored in clinic B's database.

Access would also require restricted database roles. In PostgreSQL, a role is an account or group of permissions managed by the database engine. Separating databases does not prevent an account from connecting to another clinic's database if its permissions allow it. The credentials used for clinic A would need access only to A's database and permitted operations.

The backend would still need to select the database from the authenticated user's clinic association. If it holds credentials for multiple clinics and selects clinic B's connection for a request from clinic A, database separation alone would not prevent the resulting disclosure.

### Implementation Complexity

The application could reuse the same data model and appointment logic across clinics, but it would need to manage connections to different databases. PostgreSQL has a supervisor process that listens for incoming connections and starts a dedicated server process for each connection. During connection startup, the application sends the database name and database user, and PostgreSQL checks authentication and access before accepting queries. The resulting session, meaning the interaction over that connection, stays associated with the selected database. Its server process executes SQL commands and returns results over the same connection. It can serve many successive queries, but the session cannot switch to another database.

A connection pool keeps established connections open and lends them to application operations instead of opening a new connection for every request. Returning a connection to the pool leaves its PostgreSQL session and server process running for reuse. With a database per clinic, a connection opened for clinic A cannot be reassigned to clinic B. The data access layer would need to select an available connection for the requested clinic's database or open one if necessary. Each clinic could have multiple connections, so the server processes would correspond to open connections rather than to clinics.

Registering a clinic would require an automated setup process that creates its database, installs the tables and constraints, configures access permissions, and creates its first administrator. Preparing the database structure could reuse migration scripts, which define changes to tables and other database objects. The additional implementation work would be coordinating these steps for each new clinic.

The setup process would also need to handle partial failures. PostgreSQL does not allow `CREATE DATABASE` inside a transaction block, so database creation and the subsequent setup cannot be rolled back together as one operation. For example, if creating the tables fails after the database has been created, the database remains. The application would need a defined way to retry or clean up incomplete setup without reporting the clinic as ready.

### Operations and Maintenance

Changes to tables, constraints, and indexes would need to be applied to every clinic's database. The same migration scripts could be reused, but their execution and results would need to be tracked separately for each database. If a migration succeeds for clinic A and fails for clinic B, the databases could temporarily have different structures. Deployments would therefore need to account for incomplete migrations before application code starts relying on the new structure.

Separate databases would allow a clinic's data to be exported and restored individually. PostgreSQL's `pg_dump` creates a logical export, meaning a representation of the database's structure and data rather than a copy of its underlying storage files. This would allow clinic A's database to be reconstructed without replacing clinic B's data.

Database separation would not make server maintenance independent for each clinic within the shared PostgreSQL instance. Restarting that instance would interrupt connections for all clinics. Recovery from physical backups also has a shared scope. Restoring a physical backup and replaying the WAL to a selected point in time restores the whole instance, rather than only one clinic's database.

### Resource Usage and Performance

Keeping connections open for several clinics would consume resources even when some clinics have no active requests. Each connection retains a PostgreSQL server process with its own memory and occupies a slot within `max_connections`. Connection pools would therefore need to be sized against the shared instance's capacity.

Each database would have its own tables, indexes, and system catalogs, which are PostgreSQL's internal tables describing database objects. An appointment index in clinic A's database would contain entries only for A's appointments, allowing its queries and indexes to be tuned independently. However, smaller individual indexes do not establish a performance advantage over shared tables with appropriate indexes. The potential benefit is relevant to the comparison, but its practical significance cannot be established without execution plans and measurements using equivalent data and queries.

All clinic databases would still compete for the instance's CPU, memory, and storage throughput. PostgreSQL's `shared_buffers`, the memory area that caches recently accessed blocks of table and index data, is shared across the instance rather than reserved separately for each clinic. A resource-intensive query in clinic A could therefore slow availability queries in clinic B. Database separation would provide separate data structures without guaranteeing independent performance or a reserved share of server resources.

### Implications for OLAP

A future OLAP layer would need to treat each clinic's OLTP database as a separate data source. An extraction process, which reads data from the OLTP databases and transfers it to an OLAP store, could reuse the same logic across databases with matching structures. However, it would need to connect to each database and track extraction results separately. Adding a clinic would also require including its database among the sources. This allows extraction to be scheduled or retried per clinic, but adds coordination as the number of databases grows.

Extracted records would need to retain their clinic of origin. Inside the OLTP system, the database itself identifies which clinic owns the data. That context would need to become explicit when records are copied into a common OLAP store. Identifiers cannot be assumed to be unique across independent databases unless the identifier design guarantees it. The OLAP model would therefore need to preserve clinic ownership and distinguish records from different sources without treating independent patient records as one shared clinical history.

## Schema per Clinic

### Data Isolation

Each clinic would have a separate schema within the same PostgreSQL database. A schema groups named objects such as tables, indexes, and functions. For example, `clinic_a.patients` and `clinic_b.patients` would be independent tables. Querying `clinic_a.patients` would return only A's patients, even without a clinic filter, because B's patients would be stored in another table.

Database-enforced isolation would depend on restricted access permissions. PostgreSQL requires permission to access objects in a schema and the appropriate permissions on its tables. If the role executing clinic A's queries has access only to A's schema and tables, an attempt to read `clinic_b.patients` would be rejected. This protection would also require preventing that role from obtaining broader privileges.

If the backend instead uses a role with access to every clinic's schema, PostgreSQL would permit queries against any of them. Selecting B's schema for a request from A could then expose B's patients. A missing tenant check or a manipulated clinic parameter could cause this error if the backend accepts the client's choice without verifying it against the authenticated user's clinic. Separate schemas alone would not block that access.

### Implementation Complexity

The application could reuse the same domain logic across clinics, but its data access code would need to target different schemas. For example, booking an appointment for clinic A would require every query involving the patient, professional, service, and appointment to use A's tables. Reusing that booking operation for clinic B would require directing those queries to B's tables without duplicating the booking logic.

Registering a clinic would require an automated routine to create its schema, tables, constraints, indexes, and access permissions. The routine could reuse a common structure, but object creation and foreign key references would need to target the new clinic's schema. Creating the schema alone would not create the domain tables or establish the permissions needed to use them.

These PostgreSQL setup steps could run inside one transaction, allowing their changes to be committed together or undone together if a step fails. For example, a failure while creating the appointment table could roll back the new schema and the tables already created within that transaction. This would simplify recovery from incomplete database setup compared with creating a separate database, although the setup routine would still need to handle errors and retries.

### Operations and Maintenance

Changes to tables, constraints, and indexes would need to be applied to each clinic's schema. Adding a column to `clinic_a.patients`, for example, would not add it to `clinic_b.patients`. The same migration scripts could be reused, but their progress and results would need to be tracked per schema. If an update fails for one clinic, deployments would need to account for the resulting differences before relying on the new structure.

PostgreSQL's `pg_dump` can export a clinic's schema, including its tables and data. This would allow a restore to target that clinic's objects without replacing the other clinics' tables.

All schemas would share the same database and PostgreSQL instance, so server maintenance would affect every clinic. Restarting PostgreSQL would interrupt their connections regardless of which schema they use. Physical backups and recovery through WAL would also operate on the instance as a whole. Separate schemas would therefore support selective logical exports, but would not provide independent server maintenance or direct recovery of one schema to a selected point in time.

### Resource Usage and Performance

Creating a schema would not by itself allocate a connection or a dedicated PostgreSQL server process. Those resources are associated with open connections. Because all schemas reside in one database, connections could be reused across clinics when the permissions design allows it. This could reduce the need to keep separate connections idle for each clinic.

Each clinic would require its own tables and indexes, adding another set of structures to store and maintain. For example, an index on clinic A's appointments would contain only A's records. A query using that index would search within A's data rather than an index containing appointments from every clinic. However, a suitable index on shared tables can also narrow a query to one clinic's records. Execution plans and measurements would be needed to determine whether separate indexes offer a meaningful performance benefit.

All schemas would compete for the same CPU, memory, and storage throughput. PostgreSQL's `shared_buffers`, which caches blocks of table and index data in memory, would serve the entire instance. A query reading a large appointment history in clinic A could consume resources needed by availability queries in clinic B. Separate schemas would therefore provide independent tables and indexes without reserving processing capacity or memory for each clinic.

### Implications for OLAP

A future OLAP extraction process could read several clinics' schemas through one database connection, provided its role has permission to access them. For example, it could combine appointments from `clinic_a.appointments` and `clinic_b.appointments` using `UNION ALL`, which appends the results of separate queries. This would simplify collecting data across clinics compared with connecting to a separate database for each one.

The extraction process would still need to include each clinic's schema. A query listing only clinics A and B would not automatically include clinic C when its schema is created. Adding clinics would therefore require updating the extraction sources, either automatically or through configuration. Differences caused by incomplete migrations would also need to be handled before combining results, since the selected columns must have compatible structures and data types.

Each extracted record would need to retain its clinic of origin. Once records from several schemas are combined in shared OLAP tables, the source schemas would no longer separate them. Identifiers could also overlap between schemas unless their design guarantees uniqueness across clinics. The OLAP model would therefore need to distinguish each clinic's records.

## Shared Tables with Row-Level Security

### Data Isolation

Clinics would share the same tables, with `clinic_id` identifying the clinic that owns each record. For example, the `patients` table would contain patients from clinics A and B. The column records ownership but does not restrict access by itself. Isolation would require PostgreSQL policies that use that ownership information to control access to individual rows.

RLS applies rules inside PostgreSQL to determine which rows a query may read or modify. With an active policy restricting access to clinic A, a patient query would exclude B's records even if the application omitted its clinic filter. Policies would also need to reject inserts or updates that assign a record to another clinic.

The clinic used by those policies would need to come from the authenticated user's clinic association. A client-supplied clinic identifier would not be sufficient. If the backend incorrectly establishes B as the clinic for a request from A, the policies could permit access to B's records.

Requests without a valid clinic context would need to be denied access to clinic data. Reusing a database connection must not allow a request for B to inherit A's clinic context from an earlier request.

Application connections would need database roles subject to RLS. PostgreSQL superusers and roles with `BYPASSRLS` can skip these policies. Table owners normally skip them too, unless the table is configured to enforce RLS for its owner. Using a role that bypasses RLS could therefore expose records from every clinic despite correctly defined policies.

Relationships would also need constraints that prevent references between clinics. For example, an appointment belonging to A must not reference a patient belonging to B. RLS does not automatically enforce that rule, because PostgreSQL's foreign key checks operate independently of row visibility. The relationship constraints would need to account for clinic ownership.

### Implementation Complexity

The application would use one shared set of tables and queries for all clinics. Registering a clinic would add its record and initial application data without creating another database, schema, or set of tables. Policies that compare each row's `clinic_id` with the current clinic context could also be reused without defining a separate policy for every new clinic.

Database setup would need to enable RLS and define policies separately for every table containing clinic-specific data. A policy on `patients` would not automatically protect `appointments`. Those definitions would need to cover access to existing rows and validation of inserted or updated rows.

The data access layer would need a common mechanism to establish the authenticated clinic before executing protected queries. If the context is stored in a connection setting, the context assignment and all queries for the operation would need to execute on the same connection. One option would be a transaction-local setting, whose override ends when the transaction is committed or rolled back. Implementing that option would require wrapping protected operations in transactions, including operations that only read data.

### Operations and Maintenance

Changes to tables, constraints, indexes, and shared RLS policies would be maintained in one place. Adding a column to `patients`, for example, would change the structure used by every clinic without running a separate migration for each tenant.

A full logical export of the database would contain records from all clinics. Recovering only one clinic would require selecting its rows across the relevant tables, preserving their relationships, and restoring them without replacing other clinics' data. This would require a recovery procedure that works with clinic-specific rows rather than selecting a dedicated database or schema.

All clinics would share the same PostgreSQL instance, so server restarts and maintenance interruptions would affect them together. Physical backups and recovery through WAL would also operate on the instance as a whole. RLS controls access to rows, but does not provide independent server maintenance or direct recovery of one clinic's records to a selected point in time.

### Resource Usage and Performance

All clinics would share the same tables and indexes. Adding a clinic would add records rather than another set of database objects, while the shared indexes would grow with the combined data volume. An index containing `clinic_id` together with the columns used to search appointments could help PostgreSQL locate one clinic's records without scanning the entire table. The appropriate columns and their order would need to be justified through execution plans.

RLS adds policy conditions that PostgreSQL must evaluate when accessing protected data. A policy comparing a row's `clinic_id` with the current clinic context would involve less work than a policy requiring additional queries to determine access. If transaction-local context were selected, starting transactions and establishing that context would also add work, including for read-only operations. The practical impact would need to be measured using the application's restricted database roles so that the checks actually exercise RLS.

All clinics would compete for the same CPU, memory, storage throughput, and PostgreSQL buffer cache. RLS limits which records a request may access, but does not reserve resources for each clinic. A demanding query or a large number of requests from clinic A could therefore slow clinic B's operations. Sharing tables would reduce the number of separate structures maintained, without establishing a measured performance advantage over the other strategies.

### Implications for OLAP

A future OLAP extraction process could read authorized data from the shared OLTP tables without combining separate databases or schemas for each clinic. New clinics' records would enter those same tables, so adding a clinic would not require defining another extraction source. This would simplify source management compared with maintaining a separate set of tables for every clinic.

RLS would still determine which records an extraction job may read when its database role is subject to those policies. A job using the application's clinic-scoped policies would see only the clinic established in its context. If future OLAP use cases require records from several clinics, the extraction process would need an explicitly authorized access scope. Storing all clinics together would not automatically grant permission to extract all their data.

The existing `clinic_id` would identify each record's clinic of origin and would need to be preserved when copying data into OLAP. This would avoid deriving ownership from a source database or schema name.

## Selected Strategy

The system will use shared tables with `clinic_id` and PostgreSQL RLS.

### Data Isolation

Database per clinic provides a separate database connection boundary. Schema per clinic separates tables within one database, while RLS keeps clinics' rows together and controls their visibility through policies. RLS does not provide the same separation of data objects. This tradeoff is accepted for simpler clinic registration and shared maintenance.

### Implementation Complexity

Database per clinic requires database provisioning and connection selection. Schema per clinic requires creating table sets and directing queries to the correct schema. Shared tables require RLS policies and clinic-context handling, but no new structures for each clinic. This makes the selected strategy preferable for dynamic clinic registration.

### Operations and Maintenance

Separate databases and schemas allow exports to target one clinic, but require structural changes across every clinic's objects. Shared tables centralize those changes, while recovering one clinic requires selecting related rows. The project prioritizes shared maintenance over simpler recovery of an individual clinic, favoring the selected strategy in this criterion.

### Resource Usage and Performance

Separate databases and schemas maintain table and index sets per clinic. Shared tables maintain fewer separate structures, but their indexes cover all clinics and RLS adds policy evaluation work. All three alternatives share instance resources. No performance winner has been established, so the selected strategy is favored for fewer structures, with query performance still requiring execution plans and measurements.

### Implications for OLAP

Database per clinic requires coordinating separate database sources, and schema per clinic requires collecting records from separate table sets. Shared tables provide a common source with clinic ownership already recorded in `clinic_id`. The selected strategy is preferable for extraction source management, while OLAP authorization remains a consideration for all three alternatives.

# 5. Transactions and Concurrency

# 6. Identity, Security, and Auditing

# 7. Availability, Caching, and Indexes
