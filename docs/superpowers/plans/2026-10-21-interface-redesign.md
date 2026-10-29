# Healthcare transport interface redesign

**Goal:** Replace the dark teal card-heavy interface with a warm, legible healthcare transport design across existing screens, preserving all working flows.

**Design:** Oat canvas, ink text, restrained mulberry actions, thin rules and 6–10px corners. Editorial serif only on the public introduction; operational text stays system sans with tabular times. Schedules and trips end naturally for short lists and scroll within the available workspace for long lists. Keep accessible native dialogs and the working mobile drawer. Add a shared System/Light/Dark preference, initialized before paint and persisted when browser storage is available. Driver/caregiver placeholders remain honest about unavailable functionality.

**Architecture:** Extend shared CSS semantic tokens, add one shared theme control, and refine existing shell/record markup. No backend, API, permission, routing or database changes; no dependencies.

**Authority:** User approved implementation following the audit and clarified that prior design documents and appearance-specific tests are flexible guidance.

## Tasks

- [x] Add browser tests for theme persistence/system updates, short/long schedules, responsive role screens and rendered contrast; observe failures.
- [x] Implement theme initialization/control and semantic light/dark tokens across public, signup, workspace, fields, dialogs and feedback.
- [x] Refine public introduction, anchored navigation, page headings, schedule records and trip route/timing hierarchy. Preserve search, pagination, overlays, version conflicts and all actions.
- [x] Update obsolete appearance assertions and documentation to the new design; retain functional assertions.
- [x] Run frontend/browser suite, database/API tests and production build; inspect representative light/dark mobile/desktop screenshots and fix issues.
- [x] Review diff for functional regressions, unexpected files and incomplete scope; report evidence and limitations.

## Review focus

Storage denied or invalid preferences must not prevent sign-in. System preference changes must update only System mode. At 320/375/768/1280px, header, record actions and dialogs must remain usable without page overflow. Short lists must avoid empty full-height cards; long lists retain keyboard-focusable bounded scrolling. Patient information and actions remain role scoped. Disabled values, semantic warnings/errors and focus indicators must remain legible in both themes.

## Execution notes

- The three initial tests failed for missing theme controls and a short schedule panel stretching to 812px, then passed after implementation.
- Database verification: 25 passed, 1 optional real PostgreSQL concurrency test skipped. Backend verification: 30 passed.
- Independent diff review found no important regressions; reduced-motion override feedback was addressed and covered.
- Rendered contrast checks exposed intermediate theme-transition colours; theme colours now change together without transitions on buttons/navigation.
- An old trip-status assertion addressed a removed selector even in HEAD. It now checks the existing filter overlay's real status/count options, preserving the original test intent.
- Production build succeeds with Vite's bundle-size advisory (>500kB). No new dependency was introduced.
- Final verification: `npm run test --workspace frontend` passed all 143 tests; `npm run test --workspace backend` passed all 30; `npm run test:database` passed 25 with 1 skipped; `npm run build` passed frontend and backend. `git diff --check` passed.
- Screenshots were generated at 320, 375, 768 and 1280px in both themes for existing role screens, plus public/signup and schedule forms. Representative light/dark desktop/mobile images were visually inspected. Rendered text/control colour checks passed. This is not a formal full WCAG certification.
- Driver/caregiver transport workflows and external integrations remain limited as documented before this redesign; their existing shells and unavailable states use the new design without exposing patient data or fabricating journeys.

## Follow-up refinements — 21 October 2026

The user's follow-up supersedes the original System-theme choice and sidebar/footer layout. Next pickup now shows only pickup time/status, journey date/direction, any review flag and a details action. Route addresses and treatment-derived constraints remain in the details dialog. Driver/caregiver unavailable summaries also omit empty detail fields. The clock precedes a one-click light/dark toggle; the default and legacy System fallback are Light. Desktop role navigation is in the header; mobile retains the modal drawer. Dashboard footers are removed from every role/account page, while public landing/account creation footers remain.

Verification: the three new acceptance tests first failed against the old UI. After implementation, all 15 focused theme/layout/responsive checks passed, then all 145 browser tests passed. `npm run build` passed both workspaces with the existing Vite bundle-size advisory. Light/dark desktop and 320px screenshots were inspected. No API, database, authorization or business-logic changes were made.
