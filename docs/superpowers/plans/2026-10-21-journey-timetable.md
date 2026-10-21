# Journey timetable refinement

User-approved direction: remove repetitive boxes and implement the responsive recommendations from the UI review. Keep the warm palette, desktop top navigation, mobile drawer, direct theme toggle and existing transport workflows.

## Implementation

- [x] Add browser acceptance checks for mobile patient identity/actions/sorting, natural ride-list scrolling, readable mobile titles and full-screen forms.
- [x] Refine shared dashboard CSS into open layouts with rules, quiet routine statuses and one next-pickup accent. Preserve desktop bounded lists.
- [x] Adapt the existing patient table into stacked mobile records, retaining all sorting choices and full identifiers in details.
- [x] Check representative screens in both themes, short viewports and enlarged text. Update obsolete layout assertions and run the full frontend suite and build.

Files: frontend/src/styles.css, frontend/src/pages/PatientsPage.tsx, frontend/tests/auth.spec.ts, docs/apis-and-responsive-design.md.

No API, permissions, transport state or dependencies change. Do not infer allocation semantics or shorten operational addresses. Public landing and signup keep their distinct presentation. Mobile dialogs retain native focus handling, Escape, visible actions and scrollable body.

## Verification

- New mobile acceptance tests reproduced the horizontal patient table and missing page title before implementation. Follow-up regressions reproduced inaccessible table headers and squeezed unavailable-pickup headings before fixes.
- Focused verification: 22 tests passed after updating intentional mobile layout expectations.
- `npm run test --workspace frontend`: 148 passed (3.2m).
- `npm run build`: frontend and backend passed. Existing Vite bundle-size advisory remains.
- `git diff --check`: passed.
- Reviewed fixture screenshots at 320, 375, 768 and 1280px in light/dark themes, plus short viewport and enlarged-text dialog checks. Independent code review findings resolved. Physical-device keyboard and screen-reader testing remain outside these browser checks.

## Compactness follow-up

- Grouped pickup status with the trip heading, reduced shared header and trip/schedule row spacing, and replaced the duplicate deletion details with a compact journey summary.
- Added a regression covering desktop/mobile header and row sizing, details-to-confirmation navigation, cancellation, and usable confirmation actions at 320px with short viewports and enlarged text. It failed before the implementation and passed afterward.
- Final full frontend run: 149 passed (4.0m), with tracing retained on failure. An earlier run had one header-visibility timeout; that test passed three traced repetitions and the final full run without code or timeout changes. Its original timeout was not reproduced.
- Frontend/backend build and `git diff --check` passed; existing Vite bundle-size advisory remains. Reviewed desktop and phone fixture screenshots.

## Route context and interaction follow-up

- Next pickup leads with date/direction and a plain confirmation message. Arrival constraints now belong to the appropriate route stop; destination info/delete controls replace the separate action row. Coordinator trip rows retain patient names, with full IDs in details.
- Schedule rows separate identity, session and centre, with an outlined Generate Trips button. Patient row clicks open details through the existing View button, preserving keyboard access, focus restoration, text selection and disabled states during loading.
- New trip-placement and patient-row interaction tests failed before implementation. Six focused checks passed afterward, including schedule layout and the existing details/deletion checks.
- Full browser suite: 150 passed, one account-recovery test failed because the browser could not load React (`net::ERR_NETWORK_CHANGED`, verified in its saved trace). That test then passed all three traced reruns without changing application code or timeouts.
- Frontend/backend build, frontend type check and `git diff --check` passed. Existing Vite bundle-size advisory remains. Reviewed light/dark desktop and phone screenshots; checks include 320px width and enlarged text. Physical-device testing remains outside this verification.
