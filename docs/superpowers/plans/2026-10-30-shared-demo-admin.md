# Shared Demo Administrator Access

**Goal:** Any active real coordinator with demo_admin=true may operate the existing shared seeded cohort.

**Design:** Capability is the access control; registry ownership remains immutable identity metadata. Resolve the cohort from trusted seed membership, return its owner separately, and retain the real requesting operator for authorisation/auditing. Shared controls affect the same scenario. No extra access list or fixture duplication.

**Authority:** User approved shared capability-based access and requested immediate implementation.

**Tasks:**
- [x] Extend existing backend/database cases for another flagged coordinator, retained ownership, identity mismatch and revocation.
- [x] Update service-only SQL operation and actor validity to distinguish cohort owner from active operator.
- [x] Update backend provisioning/switching/movement, UI return identity and setup docs.
- [x] Run type checks, production builds and whitespace checks; review grants and caller scope.

**Review focus:** Non-admin/seeded callers denied, actual operator recorded, original owner revocation does not block other admins, actor metadata matches cohort, no input-supplied owner, concurrent shared setup retains locking.

**Execution notes:** Tests are updated first but not executed: repository policy requires an explicit test request. No live database or deployment mutation. Preserve the existing unrelated folder-guide edit.

**Review:** Focused independent static review found no actionable issues in capability checks, shared-cohort resolution/locks, actor identity checks, service-only grants, movement scope, operator audit attribution or frontend return identity. Runtime behavior and SQL execution remain unverified because automated tests were not requested.

**Verification:** Backend source/test type-checking and both production builds passed. Database test JavaScript syntax and git diff whitespace checks passed. Automated tests and database queries were not executed. Vite retains its bundle-size advisory. Apply the current consolidated schema and deploy matching frontend/backend to activate hosted access; existing installations do not need a seed rerun.
