# Use-case coverage and implementation priorities

The submitted [use-case model](use-case-model.pdf) and [use-case descriptions](use-cases.pdf) define the project scope. This document records the current implementation and agreed revisions. The coverage table distinguishes local implementation from outstanding work; the ordered roadmap retains completed dependencies for context. Setup belongs in [Development](development.md); integration and UI conventions belong in [APIs and responsive design](apis-and-responsive-design.md).

## Current implementation

| Area | Implemented boundary | Remaining work |
| --- | --- | --- |
| Accounts and profiles — UC-01, UC-02 | Google login; atomic Patient/Driver/Caregiver signup with personal details; owned profile editing; coordinator patient Status/Notes and driver account Status editing; patient-confirmed caregiver invitations, linking/unlinking UI and assisted authorisation | User-run linked-caregiver permission/revocation verification; verified linking of existing unowned patient records |
| Vehicles — UC-02, UC-03.1 | One driver-owned vehicle; versioned submission/resubmission; coordinator approval/rejection; separate account and vehicle status | Mock review does not verify documents or legal eligibility |
| Treatment schedules — UC-03 | Recurring/single-session creation by patients/linked caregivers with final confirmation; change requests and withdrawal; coordinator approval/rejection; atomic trip reconciliation | User-run linked-caregiver verification |
| Trip generation — UC-03 | Manual generation and optional daily automatic refill; coverage indicators; deliberate deletion respected by automatic runs; explicit manual restoration | Live provider verification after credential setup |
| Assignment — UC-03.1 | Coordinator assignment/unassignment; active account/profile and approved suitable car checks; effective availability and overlap checks; version protection; driver/patient trip views | Continuity/preference ranking and live provider verification |
| Availability — UC-06 | Four dated weeks; per-week overrides of a recurring default; booked intervals in red; booking details available during viewing/editing; booked-time removal blocked; recovery preserves current reservations until approval | User-run recovery/calendar verification |
| Pickup actions — UC-11, UC-11.1 | Owned versioned confirmation/cancellation with popup review, reservation release, durable history and terminal-state preservation | User-run linked-caregiver verification and capacity-reuse proposals |
| Disruption reporting — UC-07 | Driver confirmation popup, versioned report, retained At-Risk reservation, coordinator notification, ranked upcoming recovery and confirmed active handover | User-run workflow verification |
| Operations/history — UC-04 | Coordinator trip lists and assignment risk flags; durable generation/change/assignment/traffic/recovery/handover events | User-run recovery history/notification verification |
| Notifications/history — UC-10, UC-04 | Recipient-only persistent inbox, unread/read state, safe event summaries and paginated trip history with current access checks | Linked-caregiver delivery implemented locally; user-run revocation verification |
| Routes/map — UC-08, UC-03.1 | Backend-authenticated OneMap search/drive integration, trusted cache, variable reservations, adjacent travel/availability checks, route-matched LTA observations and in-app route map | Hosted schema/browser verification |
| Execution/tracking — UC-09, UC-04 | Explicit driver Start/Complete, actual timestamps, active-trip summary, permission-based location sharing, live/stale map marker, handover cleanup and explicit replacement Start | Linked-caregiver tracking implemented locally; user-run device/handover/revocation verification |
| Traffic assessment — UC-08 | Validated cached LTA feeds, directional route matching, baseline/current ETA and delay, impact/reason, fresh-feed incident removal, verified traffic clearance, leased background checks and persistent review notifications | Hosted schema/browser verification |
| Recovery — UC-05, UC-05.1 | Ranked upcoming-trip proposals generated on demand or by the leased background worker; coordinator-confirmed safe handover for active trips; trusted revalidation, atomic approval, history and critical escalation | User-run deployment/workflow verification |
| Other use cases | Integration contracts exist | Feedback/preferences and Calendar sync |

All implemented operations still require user-run verification against the deployed schema. Documentation is not evidence that a test passed or a schema was applied.

## Implementation order

Milestones 1–6 are implemented locally. The requested automated suite passed at the documented checkpoint (68 passed, one optional concurrency check skipped); subsequent changes have not had tests executed by the agent. Read-only live OneMap/LTA diagnostics have succeeded, while hosted schema deployment and browser workflow verification remain user-run work. Browser tracking needs a secure connection and location permission. Milestone 7 includes the upcoming-trip backend/UI, automatic proposal worker and safe active handover, pending user-run verification. Milestones 8–10 remain outstanding.

### Next actions, in priority order

1. **Verify the existing foundation before expanding it.** Review and apply the consolidated schema, configure OneMap/LTA credentials, and complete the live integration checks after the passing automated checkpoint. Confirm assignment, cancellation, notifications, unavailability reports, route feasibility, Start/Complete/location permissions and traffic-monitor notification deduplication. Local implementation alone is not deployment verification.
2. **Verify recovery proposals and coordinator approval (milestone 7).** Apply the current schema and verify upcoming proposals, automatic preparation and coordinator-confirmed active handover. Check expiry/resource conflicts, original booking preservation, explicit replacement Start and previous-segment history/notifications.
3. **Verify caregiver scoped access (milestone 8).** Linking, linked-patient trip/schedule actions, notifications and tracking are implemented locally. Apply the schema and verify permission boundaries and immediate revocation on unlinking; caregivers cannot edit patient identity details.
4. **Completed-trip feedback and driver preferences (milestone 9).** Add ratings and continuity ranking after mandatory assignment constraints; calculate statistics from completed journeys.
5. **Optional Google Calendar reminders (milestone 10).** Add separate consent and reminder synchronisation once trip transitions are stable.

The use-case model makes lifecycle, notifications and disruption handling prerequisites for mapping and recovery, rather than treating a map as an isolated feature. Those foundations, tracking, traffic assessment and recovery exist locally; recovery and linked-caregiver workflows await user-run verification. Turn-by-turn navigation and automatic detours remain outside the agreed scope.

### Deferred demo tooling

Revisit after the main application is fleshed out; do not implement yet. Add a demo account switcher inside the signed-in account menu, never on the login page. Preserve the owner's real coordinator, caregiver, patient and driver accounts, and extend the optional seed with fictional patients and treatment schedules alongside dummy drivers. The proposed switcher lets the real coordinator enter explicitly tagged demo patient/driver dashboards, perform normal acknowledgement and Start/Complete actions, and return to the coordinator, with a visible demo identity indicator. Enforce the demo-mode setting and permitted targets on the backend while retaining each selected role's normal permissions. Existing dummy drivers have no Auth login, so switching requires an explicit authorisation mechanism rather than a cosmetic frontend role change.

### Full milestone sequence

Follow this order. Each milestone should finish its permissions, failure states and relevant existing tests before the next begins. The shared test ceiling remains approximately 70; agents do not run tests without an explicit request.

| Order | Milestone and use cases | Deliverable and dependency |
| --- | --- | --- |
| 1 | **Trip lifecycle rules and patient confirmation/cancellation** — UC-11, UC-11.1; supports UC-04/UC-09 | Agree lifecycle transitions, cancellation cutoff, who can act, and whether lack of confirmation changes eligibility. Keep journey progress, patient confirmation and operational risk separate. Implement authorised confirmation/cancellation, release future reservations atomically and retain history. Cancellation of a journey must not delete its treatment schedule. Driver Start/Complete actions are implemented in milestone 5. |
| 2 | **Affected-user notifications and visible trip history** — UC-10, UC-04 | Show assignment/unassignment, cancellation and approved schedule-change events to authorised recipients. Expose existing durable trip history. Establish delivery/read state and failure handling so later disruption features reuse it; transient success/error toasts are not persistent notifications. |
| 3 | **Sudden driver unavailability and manual resolution** — UC-07; initial UC-05/UC-05.1 | Allow a driver to report inability to fulfil a dated booking without bypassing booked-availability protection. Flag affected trips, notify the coordinator and allow explicit unassignment/reassignment with history. Agree handling for an already active trip. Automatic ranked recovery follows in milestone 7. |
| 4 | **OneMap routes, in-app map and assignment feasibility** — UC-08, UC-03.1 | Resolve route coordinates, display pickup/destination and driving route in Trip details, and obtain distance/approximate duration. Replace the fixed 30-minute reservation consistently across storage, assignment checks and calendars. Check travel from a preceding booking to the next pickup as well as patient journey time, with availability, overlap and treatment buffers rechecked. Keep existing assignments until an explicit reviewed change; an unavailable API must not produce a falsely confirmed estimate. |
| 5 | **Trip execution and live progress** — UC-09, UC-04 | Add authorised driver Start/Complete actions, actual timestamps and progress views using milestone 1's lifecycle. Start/Complete support Track Active Trip rather than introducing an unrelated use case. Add permission-based browser location, scoped to the assigned active journey, stale-update indicators and cleanup on end/cancellation/sign-out. Display it on the milestone 4 map. |
| 6 | **LTA traffic assessment and ETA risk** — UC-08 | Match fresh incidents and road speeds to the route, show relevant map information and reassess arrival risk near departure/during travel. Clearly distinguish scheduled pickup, planning duration and live estimated arrival. Current traffic must not be presented as a forecast for a trip days away; do not silently change bookings. |
| 7 | **Ranked recovery and coordinator approval** — UC-05, UC-05.1 | Use route/traffic assessment and current resources to propose feasible pickup, driver or route changes. Revalidate the chosen option at approval, update atomically, record history and notify affected users. Escalate when no feasible option exists. This completes Generate and Rank Recovery Options / Approve Recovery Action beyond milestone 3's manual handling. |
| 8 | **Caregiver linking and scoped workflows** — UC-02.1 and linked-caregiver actions | Implement patient-confirmed single-use invitation codes, assisted linking and unlinking. Reuse established trip, confirmation/cancellation, notification and tracking flows only for currently authorised patients. Caregivers are optional and never receive access merely by knowing a code. |
| 9 | **Driver feedback and assignment preferences** — UC-12, UC-03.1 | Permit patient ratings only for completed trips and add preferred-driver/continuity handling to candidate ranking. Apply mandatory suitability, timing and accessibility constraints before preferences. Derive ride totals from completed journeys rather than mock statistics. |
| 10 | **Google Calendar reminders** — UC-13 | Add separate optional Calendar consent and ownership-scoped reminder creation/update/removal. Reuse stable trip transitions and notifications. Calendar failures must not roll back a successful trip operation. |

Milestones 1–3 finish the operational gaps before the large mapping component. OneMap precedes live tracking and LTA so those features share an actual route. Full recovery ranking follows the route/traffic foundations. Caregiver access, feedback and Calendar remain later work, as previously agreed.

## Scope and decisions

- Preserve the 15-minute treatment buffers, five-second route-assessment target and ten-second recovery target from the use cases.
- New assignments use server-verified OneMap estimates rounded up to five-minute reservations, with driver availability for the whole journey and connecting travel. Existing 30-minute assignments remain unchanged until explicit unassignment/reassignment. See [routing setup](development.md#onemap-routing-and-assignment).
- A route map, traffic warnings and coordinator-approved recovery are within the model. Turn-by-turn navigation and automatic detours are not a committed deliverable. An external navigation link can provide driving directions; any future alternative-route selection must preserve coordinator approval rules.
- Patient cancellation is allowed only before pickup; confirmation is optional and independent of assignment. See [the current policy](development.md#patient-confirmation-and-cancellation). Do not interpret the current On-Track/At-Risk categories, or the fact that scheduled pickup time has passed, as proof that a journey started or completed.
- Initial treatment creation needs no coordinator approval. Every subsequent update, reschedule or deletion requires a request, regardless of whether trips have been generated. Existing approved details remain effective until approval.

## Current access and operational rules

All roles use `/dashboard/trips` as their dashboard landing route; caregiver transport access is restricted to currently linked active patients. Driver Trips is available with no assignments and independently of vehicle-detail loading. Before first vehicle approval, driver navigation includes Trips and Register Vehicle; after approval it includes Trips, Availability and My Vehicle. Personal details remain under Account Details with Account Management and owned Edit profile controls. Coordinators additionally manage Patients, Caregivers and Drivers.

Patients own their profiles and see only their journeys. Coordinators may edit patient Status/Notes, review treatment-change requests, review vehicle submissions and manage assignments; they cannot alter patient-owned identity details through the coordinator form. Driver Info contains personal/account details; Car contains vehicle/review details; Schedule opens the dated calendar. Drivers see only their assigned trips and cannot assign resources or read patient profile tables. Server and database checks enforce these boundaries.

The Singapore planning window is the current Monday through the fourth Sunday. Generation starts no earlier than today. Treatment schedules may extend further; existing out-of-window journeys are preserved. Automatic generation defaults off, is managed per root treatment schedule and refills opted-in schedules daily when database Cron is configured. Patient schedule rows do not expose coordinator coverage metadata. Manual regeneration can restore deliberately deleted unassigned journeys; automatic refill cannot.

Each treatment session generates outbound and return journeys. Outbound arrival is due at least 15 minutes before treatment; return pickup is no earlier than 15 minutes after treatment. Versioned approval reconciles future journeys and requires acknowledgement before releasing changed assignments. Unaffected assignments and past history remain. Coordinators delete only unassigned trips; patients separately confirm or cancel an owned upcoming journey. Cancellation preserves the journey record, releases its reservation and cannot be restored by generation.

Weekly availability defaults repeat until a dated week override exists, including an explicitly empty override. Drivers edit one selected week; booked intervals remain visible and cannot be removed until the coordinator unassigns the trip. Sudden inability to drive uses Report unavailability in Trip details; the report flags the reservation for coordinator resolution without changing saved availability. Resource eligibility loss retains reservations and flags future assignments At-Risk rather than silently releasing them.

## Caregiver linking specification

### UC-02.1 - Link Caregiver to Patient

| Item | Description |
| --- | --- |
| Actors | Patient, Caregiver; Transport Coordinator for assisted linking |
| Description | A Patient optionally authorises a Caregiver to perform permitted transport functions for them. |
| Preconditions | Patient and Caregiver accounts/profiles exist and are active. The Patient acts on their own profile; assisted linking requires an authorised Coordinator. |
| Main flow | 1. Caregiver requests a temporary, unique, single-use invitation code. 2. System displays the code and expiry. 3. Caregiver shares it with the intended Patient. 4. Patient enters the code. 5. System validates it and displays the Caregiver’s identity. 6. Patient confirms. 7. System rechecks eligibility, saves the relationship and consumes the code atomically. |
| Alternatives | An existing active relationship is reported without duplication. A Coordinator can establish the link after verifying the Patient’s authorisation. The Patient can unlink a Caregiver; the Caregiver can leave the relationship. |
| Exceptions | Incorrect, expired, revoked or used codes are rejected. Inactive accounts/profiles cannot establish a link. Cancelling confirmation creates no relationship. |
| Postconditions | A confirmed link grants only permitted Patient-specific transport access. Unlinking revokes further access without deleting the Patient or transport history. |
| Rules | A Caregiver is optional. A code alone does not grant access or create a Patient account. Code attempts are rate-limited, and relationship changes record who performed them. Server/database checks enforce current links, including after unlinking. |

The latest UC-02 description references UC-02.1 for self-service/assisted linking and retains the implemented boundary: Patients own personal details; Coordinators update Status and Notes. Caregiver access covers permitted transport functions, not unrestricted editing of Patient identity details.
