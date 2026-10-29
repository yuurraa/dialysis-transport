# Demo Clock Implementation Plan

> **For agentic workers:** Execute inline with superpowers:executing-plans, task by task.

**Goal:** Run the demo at the booked pickup time without changing its reservation.
**Architecture:** Store an optional simulated instant and real-time anchor on tagged
trips. A database helper and matching TypeScript helper resolve the clock. Existing
authorisation and booking predicates continue to apply.
**Tech Stack:** PostgreSQL, NestJS/TypeScript, React.
**Spec:** ../specs/2026-10-28-demo-clock-design.md

## Constraints and review focus

- Ordinary trips ignore clock fields; users cannot supply a clock through trip actions.
- Repeated activation does not rewind; reset isolates the archived run.
- Real expiry and freshness checks do not compare against simulated time.
- Availability checks include the entire scheduled journey, including week overrides.
- Future and past simulated dates must behave consistently across role switches.

## Tasks

- [x] Add database regression tests: due preserves reservation and confirmation;
      clock starts at pickup; start/complete use it; conflicts and unavailable driver
      still fail; reset and normal trips retain their correct clock.
- [x] Run the tests and observe failures before implementation.
- [x] Add clock columns/helper, update demo controls and trip business-time predicates
      in database/schema.sql. Keep security and real-time expiry checks intact.
- [x] Add failing TypeScript clock and simulated ETA tests, then implement shared
      clock conversion in backend/frontend and update relevant UI eligibility checks.
- [x] Display the simulated clock in Demo Tools and explain Make pickup due.
- [x] Run database/backend suites, frontend/backend builds and diff checks. Browser
      tests remain opt-in under the repository's stylesheet instructions.
- [x] Review the final diff against the spec; document deployment and any limitations.

## Verification and deployment notes

Database regression tests cover both past and future Thursday bookings, full-window
availability and overlaps, unchanged acknowledgement/reservations, clock progression,
start/completion, reset, canonical schema reapplication, actual assignment after a
75-minute route is discovered, driver contact edits, and recovery generation/approval.
TypeScript tests exercise both clock helpers and simulated ETAs with real expiry.

The independent review found the real-time cutoff in resource rechecks and the fixed
initial clock for long routes. Both were reproduced in the regression test and fixed.

Apply the updated `database/schema.sql` to the target database, then deploy/restart the
backend and frontend together. Reopen Demo Tools. Existing unstarted scenarios receive
a paused clock without moving their bookings. Do not rerun `database/seed.sql` for this
upgrade. Reset Scenario remains available if an earlier run already moved its booking.
To stop using simulation, reset the scenario or return to ordinary trips; clock fields
are ignored for untagged trips. No production database changes were made in this task.

The pre-existing patient-ID search assertion in `trip search precedes pagination and
manual generation restores deleted trips with history` has been corrected: the
patient should find their own 26 permitted trips by Patient ID, matching the shared
search query. The correction changes the test expectation only; tests have not been
rerun by the agent.
Browser tests are not run automatically under frontend/src/styles/README.md.
