# Design: Migrate Supabase to Appwrite

## Architecture Decisions

### Decision: Custom Session Cookie

**Choice**: Cookie `appwrite-session` managed via API routes + `createSessionClient()`
**Alternatives**: Let Appwrite SDK handle cookies automatically
**Rationale**: Pattern proven in `agente-omnicanal`. Explicit cookie control is more predictable in Next.js App Router, especially for middleware. Appwrite has no SSR module like `@supabase/ssr`.

### Decision: Document Collections per Table

**Choice**: One Appwrite collection per Supabase table (25 collections total), with `user_id` as indexed attribute
**Alternatives**: Merge related tables into fewer collections, relational schema
**Rationale**: One-to-one mapping minimizes refactoring scope per query. `user_id` filtering replaces RLS. Appwrite supports up to 100 collections per database.

### Decision: Service-Role via Admin Client

**Choice**: `createAdminClient()` with `APPWRITE_API_KEY` for automations/flows engines and webhooks
**Alternatives**: Use user session with elevated permissions
**Rationale**: Same pattern as Supabase's `SUPABASE_SERVICE_ROLE_KEY`. API key bypasses document permissions for background jobs.

### Decision: Manual Auth API Routes

**Choice**: Dedicated `POST /api/auth/*` route handlers instead of direct Appwrite SDK calls from pages
**Alternatives**: Call `account.createEmailSession()` directly from client components
**Rationale**: Keeps session cookie logic centralized. Server-only SDK (`node-appwrite`) handles cookies, browser SDK gets clean response.

## Data Flow

### Auth Flow

```
Browser ──POST /api/auth/login──→ Route Handler
  ├── node-appwrite: createSessionClient()
  │   └── account.createEmailSession(email, password)
  ├── Response: Set-Cookie: appwrite-session=<secret>
  └── Browser redirects to /dashboard

Middleware (every request)
  ├── Read cookie 'appwrite-session'
  ├── createSessionClient().account.get()
  ├── Valid → next()
  └── Invalid → redirect /login
```

### Database Query Flow

```
Browser Component
  └── appwrite SDK: databases.listDocuments(DB_ID, COLLECTION_ID, [
        Query.equal('user_id', userId)
      ])

Server API Route / Engine
  └── createSessionClient() or createAdminClient()
      └── databases.listDocuments(DB_ID, COLLECTION_ID, [...])
```

## Collection Mapping

| Supabase Table | Appwrite Collection | Key Attributes |
|---|---|---|
| profiles | profiles | user_id, full_name, avatar_url, beta_features |
| contacts | contacts | user_id, name, phone, email, tags, last_contacted_at |
| tags | tags | user_id, name, color |
| contact_tags | contact_tags | user_id, contact_id, tag_id |
| custom_fields | custom_fields | user_id, name, type |
| contact_custom_values | contact_custom_values | user_id, contact_id, field_id, value |
| contact_notes | contact_notes | user_id, contact_id, content, created_at |
| conversations | conversations | user_id, contact_id, status, unread_count, last_message_at |
| messages | messages | conversation_id, role, content, message_type, media_url |
| message_reactions | message_reactions | message_id, actor_type, actor_id, emoji |
| whatsapp_config | whatsapp_config | user_id, phone_number_id, access_token, webhook_secret |
| message_templates | message_templates | user_id, name, language, category, status, body |
| pipelines | pipelines | user_id, name, stages_order |
| pipeline_stages | pipeline_stages | pipeline_id, name, color, order_index |
| deals | deals | pipeline_id, stage_id, contact_id, value, expected_close_date |
| broadcasts | broadcasts | user_id, name, status, scheduled_at, total_count, sent_count |
| broadcast_recipients | broadcast_recipients | broadcast_id, contact_id, status, sent_at, delivered_at |
| automations | automations | user_id, name, trigger_type, trigger_config, is_active |
| automation_steps | automation_steps | automation_id, step_type, config, order_index |
| automation_logs | automation_logs | automation_id, contact_id, event, result, created_at |
| automation_pending_executions | automation_pending_executions | automation_id, contact_id, execute_after, step_index |
| flows | flows | user_id, name, is_active |
| flow_nodes | flow_nodes | flow_id, type, config, position_x, position_y |
| flow_runs | flow_runs | flow_id, contact_id, status, current_node_id |
| flow_run_events | flow_run_events | flow_run_id, node_id, event_type, data, created_at |

## File Changes

| File | Action |
|------|--------|
| `src/lib/appwrite/client.ts` | Create |
| `src/lib/appwrite/server.ts` | Create |
| `src/lib/appwrite/db.ts` | Create |
| `src/lib/supabase/client.ts` | Delete |
| `src/lib/supabase/server.ts` | Delete |
| `src/lib/automations/admin-client.ts` | Modify |
| `src/lib/flows/admin-client.ts` | Modify |
| `src/middleware.ts` | Modify |
| `src/hooks/use-auth.tsx` | Modify |
| `src/hooks/use-total-unread.ts` | Modify |
| `src/hooks/use-realtime.ts` | Modify |
| `src/hooks/use-broadcast-sending.ts` | Modify |
| `src/lib/dashboard/queries.ts` | Modify |
| `src/app/(auth)/login/page.tsx` | Modify |
| `src/app/(auth)/signup/page.tsx` | Modify |
| `src/app/(auth)/forgot-password/page.tsx` | Modify |
| `src/app/api/whatsapp/webhook/route.ts` | Modify |
| ~15 API routes (auth, automations, flows, broadcast, pipelines) | Modify |
| ~15 UI components | Modify |
| `src/components/settings/profile-form.tsx` | Modify |
| `package.json` | Modify |
| `.env.local.example` | Modify |
| `supabase/migrations/` | Delete |

## Testing Strategy

| Layer | Approach |
|-------|----------|
| Auth flow | Manual: signup → login → session persists → logout → cannot access dashboard |
| Database queries | `npm run typecheck` ensures all imports resolve |
| Build | `npm run build` after each phase |
