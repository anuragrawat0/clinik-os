
# AGENTS.md

## 1. Project Context

Before making changes, read:

- docs/PROJECT_CONTEXT.md
- docs/ARCHITECTURE.md
- docs/DATABASE_DESIGN.md
- docs/RBAC_MATRIX.md
- docs/DEVELOPMENT_ROADMAP.md

These documents define the approved project requirements and architecture.

## 2. Technology Stack

- Frontend: Next.js + TypeScript
- Backend: NestJS
- Database: PostgreSQL
- ORM: Drizzle
- Background jobs: pg-boss
- Video: Daily
- Payments: Stripe test mode
- Development: Docker Compose

Do not introduce additional infrastructure without approval.

## 3. Architecture Rules

- Follow the modular monolith architecture.
- Keep frontend and backend responsibilities separate.
- Follow existing module boundaries.
- Do not introduce microservices.
- Do not introduce Redis into the MVP.
- Use PostgreSQL for persistent data.
- Follow the approved database schema.

## 4. Multi-Tenant Security

- Every tenant-owned operation must enforce organization isolation.
- Never trust organization IDs supplied by users without authorization checks.
- Follow the approved RBAC matrix.
- Never bypass PostgreSQL RLS.
- Use transaction-local tenant context.
- Test cross-tenant access restrictions.

## 5. Medical Data Security

- Use synthetic patient data during development.
- Never expose sensitive medical records to unauthorized roles.
- Signed clinical records must not be silently modified.
- Audit sensitive clinical record access.
- Do not implement autonomous medical diagnosis or prescribing.

## 6. Coding Conventions

- Use TypeScript.
- Prefer explicit types.
- Keep functions and modules focused.
- Reuse existing services and components.
- Validate API inputs.
- Handle errors explicitly.
- Avoid unnecessary dependencies.
- Follow existing naming conventions.

## 7. Development Workflow

Before implementing a feature:

1. Read the relevant architecture documentation.
2. Inspect existing related modules.
3. Identify database and API dependencies.
4. Implement in the appropriate module.
5. Add or update tests.
6. Run relevant checks.
7. Report files changed and test results.

## 8. Architecture Changes

Do not silently change approved architectural decisions.

If a change is necessary:

1. Explain the problem.
2. Describe the proposed change.
3. Explain its impact on other modules.
4. Propose an architecture decision record (ADR).
5. Wait for approval before changing the architecture.

## 9. Testing Requirements

- Test important business logic.
- Test role-based permissions.
- Test tenant isolation.
- Test database constraints.
- Test appointment concurrency.
- Test payment webhook security.
- Never claim tests passed unless they were actually executed.

Use the commands defined in package.json and the project documentation.

## 10. Git Rules

- Do not overwrite unrelated changes.
- Do not commit secrets or environment files.
- Keep changes focused on the assigned task.
- Do not modify unrelated modules.
