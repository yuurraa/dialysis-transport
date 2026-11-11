# Architecture document: align with the built system

**Goal:** Bring `docs/system_architecture.py`, and the `docs/System_Architecture.pdf` it
generates, into line with the code that now exists and with the 36-state dialog map. Several
sections describe a classic ORM-based backend: Prisma repositories, a server-side RBAC guard,
a WebSocket gateway. The system we built works the other way round. Most business rules and
access control live in PostgreSQL (SQL functions and Row-Level Security), and the NestJS
backend is a thin validate-then-`rpc()` layer. A TA reading the document and then the code
would find direct contradictions, most visibly in §5.2. That section says the database
"cannot tell users apart". For user data, the database is what tells them apart.

**Design:** Keep the document's structure, layering and connector numbering C1–C9. Rewrite
only the statements the code contradicts. Where the document names a design concept that the
code implements differently, such as control classes or entities, keep the class-diagram
vocabulary and say how the code realises it, so the document still traces to
`Design_Model.puml`. Align the Presentation Layer with the dialog map merged in PR #6.

**Authority:** User request of 2026-11-01. On 2026-10-26 the team treated this document as an
idealised design and agreed not to rewrite it around implementation details such as Prisma
and Jest/Vitest. That agreement is reversed here, because the code is now complete and will be
assessed alongside this document. §5.2 in particular states the opposite of how access control
works. `lab3/System_Architecture.pdf` is the submitted Lab 3 version and is **not** touched.
`CLAUDE.md` gives Adhiraj the dialog map in `docs/`, not this file, but he wrote v2, so he
reviews the PR. Based on `main` at `62a6216`, after PR #6 (dialog map re-sync), PR #10
(Google Calendar) and the folder reorganisation.

## Evidence (what the code actually does)

Paths are relative to `backend/src/` unless stated.

| Claim in the document | What the code does | Where |
|---|---|---|
| Prisma ORM, one repository per entity | No Prisma dependency. supabase-js calls SQL functions through `.rpc()`, plus a few direct `.from()` reads. No repository classes. | `backend/package.json`, `*/*.service.ts` |
| Server uses a privileged DB account, so all checks are in API/Service layers (§5.2) | User data is read and written through a per-request client that carries the user's token (`forUser`), so RLS and checks inside SQL functions apply. A secret-key client (`forIntegration`) has five uses, some of them inside user requests: **(a)** the shared route cache, reached from trip create/update; **(b)** generating and storing recovery options; **(c)** the background traffic monitor; **(d)** Google Calendar connections and reminder sync, with OAuth tokens stored encrypted; **(e)** demo mode: demo setup, including `auth.admin` link generation, and reading `demo_trip_context` while routing demo trips. | `infrastructure/database/supabase.module.ts`; `trips/trips.service.ts:109,122` → `trips/routing/trip-routing.service.ts:42,183`; recovery `trips/routing/trip-routing.service.ts:253,261,280`; `trips/traffic/traffic-monitor.service.ts:29,51`; `integrations/calendar/calendar.service.ts`; `demo/demo.module.ts:26,47,66,69`; `trips/routing/trip-routing.service.ts:183` |
| Auth & RBAC Guard in front of every service | No NestJS guard (`CanActivate`/`@UseGuards` absent). Controllers pass the header and body through. Each service's first step verifies the token, rejects inactive accounts and roles that can never use the endpoint, and validates input. Ownership and detailed role rules are enforced by the database. | `trips/trips.controller.ts`; `trips/trips.service.ts:15-19`; same pattern in `profiles`, `scheduling`, `drivers` |
| WebSocket Gateway pushes live data; "pushed rather than polled" (C5, C6, NFR Efficiency) | No WebSocket server. The browser polls: trip progress every 5 s; notifications and availability every 15 s; the trip list and signed-in account every 30 s. | `frontend/src/features/trips/components/TripProgress.tsx:58`, `features/notifications/components/TripNotifications.tsx:55`, `features/availability/components/WeeklyAvailabilityView.tsx:27`, `features/trips/pages/TripsPage.tsx:332`, `features/auth/pages/LoginPage.tsx:91` |
| One scheduled job | Two timers: traffic monitor every 15 s, which also claims trips needing recovery and generates options automatically (UC-05.1); calendar sync every 30 s. | `trips/traffic/traffic-monitor.service.ts`, `integrations/calendar/calendar.service.ts:198-201` |
| Transactions via Prisma `$transaction` (§5.1) | Each SQL function runs as one transaction, e.g. cancelling a trip and releasing its driver happen in one function call. | `database/schema.sql` (`private.patient_trip_action`) |
| Entity classes with behaviour, e.g. `Trip.updateStatus()` | No entity classes. Most entities have their own table; some are part of another table (a Transport Coordinator is an `accounts` row with the coordinator role; there is no TrafficDisruption table). TypeScript types live in `common/types.ts`. Entity rules are table constraints and SQL functions. | `database/schema.sql`, `common/types.ts` |
| Strategy objects rank assignments and recovery options | No strategy objects. Ranking is inside SQL functions. `Design_Model.puml` has no Strategy either. | `database/schema.sql`, `docs/Design_Model.puml` |
| 5-second timeout on external calls | True per single OneMap/LTA/Calendar call. Exceptions: LTA bulk fetch 20 s, route recalculation 10 s, one routing step 12 s. | `integrations/lta/lta.service.ts:95`, `trips/routing/trip-routing.service.ts:67,261,280` |
| Jest, Vitest, React Testing Library | Backend: Node test runner via `tsx --test`. Frontend: Playwright. | `backend/package.json`, `frontend/package.json` |
| Access matrix: only Coordinators link Caregivers; Caregivers have no schedule access | Caregivers create invitations and Patients confirm them; any of the three roles can unlink; only a Coordinator, with the Patient's authorisation, re-activates a link. Caregivers create, edit and delete schedules for linked Patients; Coordinators also review schedule change requests. | `profiles/profiles.service.ts:156-178`; `scheduling/scheduling.service.ts:15,54,104,119` |
| Presentation lists the 28-state dialog map | The merged dialog map has 36 states and adds Coordinator Trip Details, Caregivers, Drivers, Driver Trip Details, Driver Availability, My Vehicle, Patient Trip Details and Caregiver Connections. | `docs/dialog_map.py` |

These statements are **consistent** with the code and stay: the layering, C1/C2/C4/C8/C9,
Google OAuth via Supabase Auth with no password form, one adapter per external service
(`integrations/`), the access matrix, the rule that only the latest location of an active
trip is stored and cleared when the trip ends, and the rule that calendar events carry only
the pickup time, origin and destination.

## Tasks

1. **Figure 1.**
   - Presentation Layer: list the dialog-map screens per role, including the eight new ones.
     Confirmations, forms and exception states stay in the dialog map, as the caption says.
   - Data Layer: replace "Repositories (DAO) / Prisma ORM" with "SQL Functions + RLS".
   - **C3** becomes "supabase-js `rpc()` with the user's token". **C7** is redefined, not
     removed: "supabase-js with the secret key" for the five uses above.
   - API Layer: keep only REST Controllers. Remove "Auth & RBAC Guard" and the WebSocket
     Gateway. Token and input validation is the Service Layer subtitle, because each service
     performs it as its first step.
   - Timers: `MonitoringControl` and `CalendarSyncControl` start their own timers in
     `onModuleInit`, so they are marked in their Service Layer boxes ("timer, every 15 s /
     30 s") with a C5 note, instead of a separate box in the API Layer.
   - Draw C1 and C6 on one arrow above REST
     Controllers, because requests reach a controller first and C6 is repeated C1 requests.
   - C7 runs around the SQL Functions + RLS box straight to the database, so it does not look
     as if it passes through RLS.
   - Data Layer: a larger PostgreSQL cylinder below both boxes; Entities and SQL Functions
     both point into it.
   - C9: move Supabase Auth next to the Shared Entry UI, which holds the Login screen.
   - Legend: solid line means "request or call (synchronous)"; dashed means secret-key access.
2. **§2 Architectural style.** Drop the event-system claim. State that updates reach the
   browser by polling and background work starts on timers. Rewrite the Separation of
   concerns, Low coupling and Single responsibility principles to match (the Service
   Layer, not the API Layer, authenticates).
3. **§3 Components.** Add an **"Implemented in"** column. Keep the 13 `XxxControl` names and
   state the many-to-one mapping onto `auth`, `profiles`, `scheduling`, `drivers`, `trips`
   and `integrations`. Point UI rows at `frontend/src/features/*`. Update the UI rows with the
   new dialog-map screens.
   Token and input validation is not a separate row: the section intro states that every
   service starts with it, matching the Service Layer subtitle in Figure 1.
4. **§4 Connectors.** Update C3, C5, C6 and C7. Replace the "Why C5 and C6 are not calls" note
   with "Why polling rather than push" and "Why C7 is dashed".
5. **§5.1 Persistent data.** Rules live in SQL functions; each function is atomic; entities
   map to tables.
6. **§5.2 Access control.** User data carries the user's identity and is checked by RLS and
   SQL functions; each service first rejects roles that can never use the endpoint; the
   secret key has the five uses above.
7. **§5.3 External services.** Timeouts: 5 seconds per call; 10–20 seconds for bulk LTA
   fetches and route recalculation.
8. **§5.4 Patterns.** Remove DAO, Observer and Strategy. Add "Database-enforced rules".
9. **§6 NFRs.** Security: *most* data access is enforced by the database; no claim that leaks
   are impossible. Update Robustness, Efficiency, Maintainability and Privacy.
10. **§7 Constraints.** supabase-js, Node test runner and Playwright; HTTPS polling instead of
    WebSocket.
11. **Subtitle.** "Final Version".
12. **Regenerate.** `python docs/system_architecture.py`. Leave `lab3/` unchanged.

## Decisions (2026-11-01)

1. **Scope.** The document must match the code for the final submission.
2. **Service names.** Keep the 13 `XxxControl` names and add an "Implemented in" column.
3. **Entities.** Entities are mapped to tables (some as part of another table) plus SQL-enforced rules, not classes with methods.
4. **Strategy pattern.** Removed. The code and the class diagram both lack it.
5. **Subtitle.** "Final Version".
6. **C7.** Redefined as the secret-key connection, not merged into C3.
7. **Thin services.** Figure 1 keeps the control classes in the Service Layer without marking
   which are thin; the text explains where the rules live.

## Review focus

- **No new contradictions.** Every changed sentence should be checkable against a file named
  in the evidence table. §3, C7, §5.2 and §6 must all list the same five secret-key uses.
- **Traceability kept.** Control-class names must still match `Design_Model.puml`. Screen
  names must match the 36-state dialog map.
- **Figure 1 readability.** The Coordinator UI box now has five lines; check it does not
  overflow, and that no connector crosses a label.
- **Submitted copy untouched.** `git diff --stat` must not list anything under `lab3/`.

## Execution notes

- Edit only `docs/system_architecture.py`. The HTML and PDF are generated.
- PDF generation needs Python Playwright with Chromium installed.
- Keep §5.2's access matrix, §5.4 and §7 unsplit across pages (`.sec` wrappers).
- Share a PNG of Figure 1 for visual review before opening the PR.
