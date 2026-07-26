# Tasks: Migrate Supabase to Appwrite

## Review Workload Forecast

```
Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: auto
400-line budget risk: High
```

## Phase 0: Foundation

- [ ] 0.1 Install `appwrite@^16` + `node-appwrite@^14`
- [ ] 0.2 Create `src/lib/appwrite/client.ts` (browser SDK: Client, Account, Databases)
- [ ] 0.3 Create `src/lib/appwrite/server.ts` (createSessionClient + createAdminClient)
- [ ] 0.4 Create `src/lib/appwrite/db.ts` (DB_ID const, 25 collection ID constants, TypeScript types)
- [ ] 0.5 Update `.env.local.example` with Appwrite vars
- [ ] 0.6 Create Appwrite collections via admin API (setup script)

## Phase 1: Auth

- [ ] 1.1 Create `POST /api/auth/signup` route handler
- [ ] 1.2 Create `POST /api/auth/login` route handler
- [ ] 1.3 Create `POST /api/auth/logout` route handler
- [ ] 1.4 Create `POST /api/auth/recovery` route handler
- [ ] 1.5 Modify `src/middleware.ts` (createSessionClient + account.get + protected routes)
- [ ] 1.6 Modify `src/hooks/use-auth.tsx` (replace supabase.auth → appwrite account)
- [ ] 1.7 Modify auth pages: login, signup, forgot-password
- [ ] 1.8 Modify `sessions-card.tsx` (global signOut)

## Phase 2: Database Core

- [ ] 2.1 Modify `src/hooks/use-total-unread.ts` (databases.listDocuments conversations)
- [ ] 2.2 Modify `src/hooks/use-realtime.ts` (client.subscribe instead of supabase.channel)
- [ ] 2.3 Modify `src/lib/dashboard/queries.ts` (all dashboard stats queries)
- [ ] 2.4 Modify `src/app/api/whatsapp/webhook/route.ts` (webhook handler)
- [ ] 2.5 Modify API routes: send, react, media, config, templates/sync
- [ ] 2.6 Modify inbox components: conversation-list, message-thread, contact-sidebar, template-picker

## Phase 3: Database Business

- [ ] 3.1 Modify `src/hooks/use-broadcast-sending.ts`
- [ ] 3.2 Modify API routes + components for broadcasts
- [ ] 3.3 Modify pipelines (kanban) page + components + deal-form + pipeline-settings
- [ ] 3.4 Modify automations engine, API routes, components
- [ ] 3.5 Modify flows engine, API routes, components
- [ ] 3.6 Modify contacts components: contact-form, contact-detail-view, import-modal, tag-manager

## Phase 4: Storage + Cleanup

- [ ] 4.1 Modify `profile-form.tsx` (avatar upload → Appwrite Storage)
- [ ] 4.2 Delete `src/lib/supabase/` directory
- [ ] 4.3 Delete `src/lib/automations/admin-client.ts` and `src/lib/flows/admin-client.ts`
- [ ] 4.4 Remove `@supabase/ssr` and `@supabase/supabase-js` from `package.json`
- [ ] 4.5 Delete `supabase/migrations/` directory
- [ ] 4.6 Run `npm run typecheck` and fix any issues
- [ ] 4.7 Run `npm run build` to verify
