# Use-case coverage

The Lab 3 use cases govern implementation, with the agreed revisions below. These revisions extend the submitted PDF; they do not indicate completed functionality.

| Use cases | Backend responsibility | Frontend boundary |
| --- | --- | --- |
| UC-01 | Auth: identity, active account and assigned role | Login; subsequent permitted role view |
| UC-02, UC-02.1 | Profiles: patient ownership, records and caregiver links | Patient profile and coordinator views; caregiver linking pending |
| UC-03, UC-03.1 | Scheduling: patient treatment requirements, recurring outbound/return trips and matching | Patient/linked-caregiver treatment entry; coordinator transport arrangements |
| UC-04 | Trips: dashboard and history | Coordinator view |
| UC-05, UC-05.1 | Trips: recovery options and approval | Coordinator view |
| UC-06, UC-07 | Scheduling: availability and sudden unavailability | Driver view |
| UC-08 | OneMap/LTA adapters; trip assessment and risk decisions | Coordinator and assigned-trip views |
| UC-09 | Trips: location updates and authorised active-trip tracking | Patient/caregiver and coordinator views |
| UC-10 | Trips: affected-user notifications | Appropriate authenticated role view |
| UC-11, UC-11.1 | Trips: upcoming pickup, confirmation and cancellation | Patient/caregiver view |
| UC-12 | Trips: rating and driver preference | Patient-only actions in the shared view |
| UC-13 | Calendar adapter; reminder sync following trip changes | Patient/caregiver view |

Keep mandatory assignment constraints ahead of patient preference and driver continuity. Preserve the standard 15-minute buffer, five-second route assessment target and ten-second recovery target. Caregivers may act only for currently linked patients. Location sharing ends with the active trip; calendar failure must not prevent core trip operations.

The first operational slice creates only Unfilled trips. Requirement changes are tracked internally; trip screens do not display a separate review label or message. Driver/vehicle assignment, the wider lifecycle, operational risk transitions and confirmation status still need agreement. Refine the WIP diagrams before expanding the declarations. There is no demo role switcher or fake successful business operation in this skeleton.

## Account onboarding

UC-01 assumes existing accounts and roles; UC-02 covers coordinator-managed operational records. Signup is Google → Username/Role → Next → role-appropriate details/review → Sign Up, within the landing card. Patient and Driver accounts and owned profiles are saved atomically on final submission; coordinators remain manually provisioned. Next/Back only change local form state. Patients complete personal and transport details and Drivers complete personal details before entering the dashboard; legacy accounts missing their role profile also finish on the landing page. Both signup forms collect date of birth and gender alongside name and contact number. Existing Patient records may retain NULL demographics until updated; no values are fabricated. Driver verification (FR-3.3) and caregiver–patient links (UC-02.1) remain separate requirements. See [Authentication](authentication.md).


## Function pages

Patients, Caregivers and Coordinators use `/dashboard/trips`; Drivers enter `/dashboard/vehicle` with Register Vehicle as their only main navigation tab. All roles retain `/dashboard/account`. Coordinators additionally have Drivers at `/dashboard/drivers` and Patients at `/dashboard/patients`, with Patient Management / Patients List headings on that screen. `/dashboard` redirects to the role’s main function; Overview and the detached Manage your journey panel are removed. Menu labels name functions, with additional functions added as they are implemented. The shared responsive header, drawer and account dropdown retain the existing dashboard styling. Only Transport Coordinators see the generic Account details section in My Account. Patients see their owned transport details; Drivers see their saved personal signup details as read-only; patients, drivers and caregivers do not receive the generic Account details section. The role tag uses the shared names, including Transport Coordinator.

Coordinator Trips retains the UC-04 Unfilled, At-Risk, On-Track and Resolved categories and now reads persisted journeys with bounded date filtering and pagination. Newly generated journeys are Unfilled; no assigned, on-track or resolved journeys are invented. Patients read only their own journeys and see pending pickup details. Driver/caregiver Trips remains unavailable until assignments and confirmed caregiver links exist. Matching, tracking, calendar actions and feedback remain pending.

## Patient record boundary

UC-02 patient record management is implemented at `/dashboard/patients`: active coordinators can read records with name, contact number, street/unit/postal address, mobility, assistance needs and optional notes. Coordinators may update only Status and Notes; the UI, API and database enforce this. Patient creation belongs to signup. Each self-service patient profile has one owning patient account. Patients complete/edit it at `/dashboard/account`, and coordinators manage the same record. Existing coordinator-created records remain unowned and are not automatically matched to accounts. NestJS verifies the active account and role on each request; RLS permits patient reads only of their own profile, while a narrow owner-save function prevents changing ownership or status. Coordinator record management remains available; deletion is not permitted. Linking legacy records, caregiver records and caregiver access remain outstanding. Driver personal profiles now belong to signup; vehicle registration and coordinator Driver management/approval are implemented as described below; assignment remains pending. The Lab 3 UC-02.1 description already includes patient-confirmed, single-use caregiver invitation codes and coordinator-assisted linking. Linking remains unimplemented; the clarifications below still need to be reflected in the submitted descriptions/model where applicable. See [Development](development.md) for applying the schema.

## Trip page boundary

Personal-role Trips prioritises next pickup, destination, driver, vehicle and return pickup above the ride list. Patient and Coordinator trip retrieval is implemented. Pickup remains pending until actual transport timings/resources are arranged; arrival deadlines and earliest return pickup are labelled separately. Driver and Caregiver trip services remain unavailable. The detached ride-actions panel is removed. Confirmation, cancellation, tracking and calendar actions should be attached to the relevant trip when implemented (UC-09, UC-11 and UC-13); completed-trip feedback and preferences belong to UC-12. Personal details remain under My Account.

## Agreed use-case revisions

### UC-03 - Manage Treatment and Transport Schedules

| Item | Description |
| --- | --- |
| Actors | Patient, linked Caregiver, Transport Coordinator |
| Description | Patients or linked Caregivers record treatment requirements; Coordinators arrange the corresponding transport. |
| Preconditions | The actor has an active account and permission for the Patient. The Patient profile and selected DialysisCentre exist. Resource information is available when assignment is attempted. |
| Main flow | 1. Patient or linked Caregiver enters the centre and times, then a recurring weekday/effective date range or a single session date. 2. System validates and saves the treatment schedule. 3. Coordinator reviews the requirements and initiates transport scheduling. 4. System registers outbound/return Trips using the treatment times and standard 15-minute buffer. 5. UC-03.1 assigns suitable Drivers and Vehicles where available. 6. System stores transport timings and assignments; unmatched Trips remain Unfilled. |
| Alternatives | Coordinator may record treatment requirements on the Patient’s behalf. Changes to treatment requirements flag affected future Trips for coordinator review and recalculation; existing arrangements are not silently presented as valid. |
| Exceptions | Invalid or overlapping treatment sessions are rejected. Missing suitable resources leave Trips Unfilled. |
| Postconditions | Treatment requirements are stored separately from transport pickup times. Trips and assignments are stored when transport scheduling is performed. |
| Rules | Treatment submission does not confirm transport. Patients/Caregivers cannot assign resources or set operational pickup times. No separate treatment-approval workflow is required. Completed Trips retain their history. Single replacements exclude only their linked original occurrence; failed saves leave that occurrence unchanged. |

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

## Next implementation slice

Patient treatment-schedule creation and persistence, and the Coordinator read view, are implemented at `/dashboard/schedules`. Recurring and single-session creation requires a final review confirmation explaining that any later change, rescheduling or deletion needs coordinator approval, regardless of generated trips. Direct schedule mutation stays blocked in the UI, API and database client permissions. Patients use the edit icon to request an update, deletion, or one-occurrence reschedule with a reason. Pending/rejected badges expose the request. Coordinators approve or reject in a current-versus-proposed popup; rejection requires a reason. Approval is version checked and atomically reconciles future unfilled trips while preserving past history and deliberate deletions. Patients may withdraw pending requests. Existing replacement records stay readable and trip generation respects their original-date exclusions. Coordinator manual/automatic generation, idempotency, trip history, driver vehicle registration and availability remain implemented. Assignment, transport execution and caregiver linking remain pending.


Driver vehicle registration is implemented for one driver-owned vehicle, using mock licence/vehicle details without document uploads. Drivers retain login access while Not submitted, Pending review or Rejected, and their main tab is Register Vehicle. The coordinator Drivers tab includes all Driver accounts, with or without personal profiles or vehicle submissions. Driver Details follows the Patient Details form layout, with Edit Driver → Save Driver/Cancel for versioned Active/Inactive account Status changes. A car icon immediately left of Info opens a separate Car Details dialog for vehicle data and approval/rejection; Info contains only personal details and account Status. Car Details shows Submitted on until approval, then Registered on using the approval date. Identity and vehicle approval cannot be changed through the Status edit. Coordinators approve/reject only current Pending review submissions from active Driver accounts; rejection requires a reason. Pending/Rejected/Approved registrations can be corrected and resubmitted for another review; every submission requires confirming an overlay warning that it replaces the previous submission. Versions protect against stale submissions/reviews, vehicle plates are unique, and submission/review snapshots retain audit history. The milestone ends at approval: availability, resource assignment and trip execution remain unimplemented.

## Initial transport journeys

Coordinator **Generate Trips** opens an overlay on the schedule list. Choose a future inclusive range of up to 90 days. Every matching session creates an outbound home-to-centre journey and a return centre-to-home journey, initially Unfilled. Arrival is due 15 minutes before treatment starts; return pickup cannot be earlier than 15 minutes after treatment ends. Home pickup and actual return pickup remain unset. These are treatment-derived requirements, not a confirmed transport booking or a route-derived pickup estimate.

The selected schedule version is rechecked under the same Patient lock used by treatment changes. Journey identity is stable across retries and replacement/restoration of a recurring occurrence. Independent single-session journeys also retain identity when their session date changes. Source edits/deletion and Patient detail changes mark affected unfilled journeys for review rather than silently keeping stale transport details valid. Regenerating matching sessions refreshes their requirement snapshots and records history. Removed occurrences without a current replacement remain flagged for coordinator review; Coordinators can explicitly delete an unassigned journey after confirmation; its history remains; automatic generation respects the deletion and explicit manual generation can restore it. Assigned-trip cancellation/recovery and broader lifecycle actions are later slices. Past journey history is preserved.

Coordinator and Patient Trips lists use server-side date filtering, stable pagination and real empty/error states. The Patient next-pickup card is independent of list filtering and shows pending pickup, relevant arrival/return constraints without an additional review label. Only active Coordinators generate journeys; Patients read only owned journeys. Direct writes to Trips/history are revoked, and Drivers/Caregivers receive no access in this slice.

Trip lists now support server-side route/date/time/type/status search (plus Patient name/ID for Coordinators), direction filters and compact status counts. Coordinators can delete an individual unassigned Trip with version checks and retained audit history; Patients cannot delete transport arrangements.

UC-06 now has an initial Driver availability slice at `/dashboard/availability`: approved active drivers save weekly half-hour slots, with empty initial availability, explicit Save/Cancel and stale-version protection. The desktop weekly grid and mobile day view share the dashboard styling. Automated assignment and UC-07 sudden-unavailability recovery remain pending; availability edits do not currently change Trips or initiate reassignment.
