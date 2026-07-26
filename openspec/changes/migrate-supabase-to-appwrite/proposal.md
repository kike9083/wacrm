# Proposal: Migrate Supabase to Appwrite

## Intent

Replace Supabase (Auth, Database, Storage, Realtime) with the self-hosted Appwrite server on VPS with EasyPanel, unifying the project's backend stack with the sibling projects in the monorepo.

## Scope

### In Scope
- Migrate Auth: signup, login, forgot-password, signout, session management, middleware
- Migrate Database: 18 tables → Appwrite document collections with equivalent access control
- Migrate Storage: avatar bucket → Appwrite Storage
- Migrate Realtime: subscriptions on conversations/messages/flows → Appwrite Realtime
- Migrate service-role: automation and flow engines use API Key instead of SUPABASE_SERVICE_ROLE_KEY
- Remove `@supabase/*` dependencies and old client files

### Out of Scope
- UI/UX changes beyond what migration requires
- Data migration of existing records (separate script)
- Business logic refactoring

## Capabilities

### Modified Capabilities
- `auth`: backend changes from Supabase Auth to Appwrite Auth
- `database`: backend changes from Supabase PostgREST to Appwrite Databases
- `storage`: backend changes from Supabase Storage to Appwrite Storage
- `realtime`: backend changes from Supabase Realtime to Appwrite Realtime

## Approach

Layered migration from data layer up: Foundation → Auth → Database (core → business) → Storage → Cleanup. 5 chained PRs to stay within 400-line review budget.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/lib/appwrite/` | New | Client factories (browser, server, admin) |
| `src/lib/supabase/` | Removed | Old Supabase clients |
| `src/middleware.ts` | Modified | Session validation via Appwrite |
| `src/hooks/` | Modified | 5 hooks replacing supabase calls |
| `src/app/(auth)/` | Modified | 3 auth pages |
| `src/app/api/` | Modified | ~15 API routes |
| `src/components/` | Modified | ~15 UI components |
| `supabase/migrations/` | Removed | SQL migrations |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Relation-to-document mapping complexity | Medium | One-to-one mapping first, optimize later |
| Session cookie compatibility | Low | Pattern already proven in agente-omnicanal |
| Broken active sessions during migration | Medium | Coexistence, progressive rollout per phase |

## Success Criteria

- [ ] Login/registration works end-to-end with Appwrite Auth
- [ ] All database queries execute against Appwrite Databases
- [ ] Avatars upload/display from Appwrite Storage
- [ ] Realtime updates function in inbox and dashboard
- [ ] `@supabase/*` fully removed from package.json
- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds
