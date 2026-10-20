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

Lifecycle, operational risk and confirmation status still need agreement. The starting contracts deliberately do not fix these provisional states. Refine the WIP diagrams before expanding the declarations. There is no demo role switcher or fake successful business operation in this skeleton.

## Account onboarding

UC-01 assumes existing accounts and roles; UC-02 covers coordinator-managed operational records. Signup is Google → Username/Role → Next → role-appropriate details/review → Sign Up, within the landing card. Patient accounts and owned profiles are saved atomically on final submission; coordinators remain manually provisioned. Next/Back only change local form state. Patients complete transport details before entering the dashboard; legacy incomplete accounts also finish on the landing page. Driver verification (FR-3.3) and caregiver–patient links (UC-02.1) remain separate requirements. See [Authentication](authentication.md).


## Function pages

Every active role uses `/dashboard/trips` and `/dashboard/account`. Coordinators additionally have Patients at `/dashboard/patients`, with Patient Management / Patients List headings on that screen. `/dashboard` redirects to Trips; Overview and the detached Manage your journey panel are removed. Menu labels name functions, with additional functions added as they are implemented. The shared responsive header, drawer and account dropdown retain the existing dashboard styling. Only Transport Coordinators see the generic Account details section in My Account. Patients see their owned transport details; patients, drivers and caregivers do not receive the generic Account details section. The role tag uses the shared names, including Transport Coordinator.

Coordinator Trips retains the UC-04 Unfilled, At-Risk, On-Track and Resolved categories. Patient/caregiver/driver Trips currently provides unavailable trip information without invented records or successful operations. Operational retrieval, matching, tracking, calendar actions and feedback remain pending.

## Patient record boundary

UC-02 patient record management is implemented at `/dashboard/patients`: active coordinators can read records with name, contact number, street/unit/postal address, mobility, assistance needs and optional notes. Coordinators may update only Status and Notes; the UI, API and database enforce this. Patient creation belongs to signup. Each self-service patient profile has one owning patient account. Patients complete/edit it at `/dashboard/account`, and coordinators manage the same record. Existing coordinator-created records remain unowned and are not automatically matched to accounts. NestJS verifies the active account and role on each request; RLS permits patient reads only of their own profile, while a narrow owner-save function prevents changing ownership or status. Coordinator record management remains available; deletion is not permitted. Linking legacy records, caregiver/driver/vehicle records and caregiver access remain outstanding. The Lab 3 UC-02.1 description already includes patient-confirmed, single-use caregiver invitation codes and coordinator-assisted linking. Linking remains unimplemented; the clarifications below still need to be reflected in the submitted descriptions/model where applicable. See [Development](development.md) for applying the schema.

## Trip page boundary

Personal-role Trips prioritises next pickup, destination, driver, vehicle and return pickup above the ride list. Current trip services are pending, so data is explicitly unavailable. The detached ride-actions panel is removed. Confirmation, cancellation, tracking and calendar actions should be attached to the relevant trip when implemented (UC-09, UC-11 and UC-13); completed-trip feedback and preferences belong to UC-12. Personal details remain under My Account.

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

Patient treatment-schedule entry/editing, persistence and the Coordinator read view are implemented at `/dashboard/schedules`. Recurring, single and one-occurrence rescheduling are implemented, with atomic replacement links and overlap checks. Edit contains the whole-series/one-session scope choice. One-session editing offers the actual, not-yet-replaced occurrences in a bounded dropdown and an adjacent new date; validation/save errors use dismissible overlay toasts. The same Save/Cancel/Delete layout is retained in both edit scopes. Rescheduled-session counts open a bounded detail list instead of growing date paragraphs. Patients can delete owned schedules after confirmation; series deletion includes linked replacements, while replacement deletion restores its original occurrence only if overlap validation succeeds. Coordinators remain read-only. Schedule search and pagination now run before retrieval in the database, preserving replacement context across pages. Patient/profile and schedule edits use version checks to reject stale concurrent writes; schedule deletion also checks its version. Database date bounds and nonempty recurrence checks protect direct inserts as well as API requests. Recurring Trip generation and resource assignment remain pending. Caregiver treatment entry depends on UC-02.1 linking; until that is implemented, Caregiver accounts receive no Patient access. Linking also needs a minimal Caregiver profile, since the use case requires one. Caregiver linking and operational transport scheduling remain pending.
