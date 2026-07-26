# Delta for Auth, Database, Storage, Realtime

## ADDED Requirements

### Requirement: Appwrite Client Layer

The system MUST provide three Appwrite client factories in `src/lib/appwrite/`:

- `client.ts` — browser SDK (`appwrite`), singleton `Client` with `Account` and `Databases` instances
- `server.ts` — server SDK (`node-appwrite`) exporting:
  - `createSessionClient()` — reads `appwrite-session` cookie, returns `account` + `databases`
  - `createAdminClient()` — uses `APPWRITE_API_KEY`, returns `account` + `databases` + `users`
- `db.ts` — constants for `DATABASE_ID` and all collection IDs

#### Scenario: Browser client creates singleton

- GIVEN the app loads in the browser
- WHEN `client.ts` is imported
- THEN it MUST initialize and export a singleton `Client` connected to `NEXT_PUBLIC_APPWRITE_ENDPOINT` and `NEXT_PUBLIC_APPWRITE_PROJECT_ID`
- AND export `account: Account(client)` and `databases: Databases(client)`

#### Scenario: Server session client reads cookie

- GIVEN an incoming request with cookie `appwrite-session=valid_token`
- WHEN `createSessionClient()` is called
- THEN it MUST create an authenticated `Account` and `Databases` client

#### Scenario: Admin client uses API key

- GIVEN `APPWRITE_API_KEY` is set
- WHEN `createAdminClient()` is called
- THEN it MUST create a privileged client with full access

### Requirement: Appwrite Auth Flow

The system MUST replace all `supabase.auth.*` calls with Appwrite Auth equivalents.

| Supabase | Appwrite |
|---|---|
| `auth.signUp({ email, password })` | `account.create(userId, email, password, name)` |
| `auth.signInWithPassword({ email, password })` | `account.createEmailSession(email, password)` |
| `auth.resetPasswordForEmail(email)` | `account.createRecovery(email, redirectUrl)` |
| `auth.signOut()` | `account.deleteSession('current')` |
| `auth.getUser()` | `account.get()` |
| `auth.onAuthStateChange(callback)` | Poll `account.get()` + cookie check on mount |

#### Scenario: User signs up

- GIVEN the user submits the signup form with email + password + name
- WHEN the API route `POST /api/auth/signup` is called
- THEN it MUST call `account.create()`
- AND `account.createEmailSession()` auto-login after creation
- AND set cookie `appwrite-session` with the session secret
- AND redirect to `/dashboard`

#### Scenario: User logs in

- GIVEN the user submits the login form with email + password
- WHEN `POST /api/auth/login` is called
- THEN it MUST call `account.createEmailSession()`
- AND set cookie `appwrite-session` with the session secret
- AND return 200 with user data

#### Scenario: User logs out

- GIVEN the user is logged in
- WHEN `POST /api/auth/logout` is called
- THEN it MUST call `account.deleteSession('current')`
- AND clear the `appwrite-session` cookie
- AND redirect to `/login`

### Requirement: Database Operations

The system MUST replace every `supabase.from('table').select/insert/update/delete` call with equivalent `databases.listDocuments/createDocument/updateDocument/deleteDocument` calls, filtering by `user_id` where applicable.

#### Scenario: List documents with user filter

- GIVEN a logged-in user wants to fetch their contacts
- WHEN `databases.listDocuments(databaseId, collectionId, [Query.equal('user_id', userId)])` is called
- THEN it MUST return only documents where `user_id` matches the current user

#### Scenario: Create document with permissions

- GIVEN a user creates a new contact
- WHEN `databases.createDocument(databaseId, collectionId, documentId, data)` is called
- THEN the document MUST include `user_id` in its data
- AND read/write permissions MUST restrict access to the creating user

## MODIFIED Requirements

### Requirement: Session Middleware

The middleware MUST validate sessions via `createSessionClient().account.get()` instead of `createServerClient().auth.getUser()`. The cookie name changes from Supabase internal cookies to `appwrite-session`.
(Previously: middleware used `@supabase/ssr` `createServerClient` with `auth.getUser()`)

#### Scenario: Authenticated user accesses dashboard

- GIVEN the user has a valid `appwrite-session` cookie
- WHEN they request `/dashboard`
- THEN the middleware calls `createSessionClient().account.get()`
- AND allows the request to proceed

#### Scenario: Unauthenticated user accesses protected route

- GIVEN the user has no valid session cookie
- WHEN they request `/dashboard`
- THEN the middleware redirects to `/login`

#### Scenario: Authenticated user visits login page

- GIVEN the user has a valid session
- WHEN they request `/login`
- THEN the middleware redirects to `/dashboard`

### Requirement: Realtime Subscriptions

The system MUST replace `supabase.channel()` Realtime subscriptions with Appwrite's `client.subscribe()`.
(Previously: used `@supabase/realtime-js` via Supabase channels)

#### Scenario: Subscribe to conversation changes

- GIVEN the user is on the inbox page
- WHEN conversations are updated
- THEN the Realtime subscription MUST deliver the event
- AND the hook updates the conversation list

## REMOVED Requirements

### Requirement: Supabase Client Layer

(Reason: replaced by Appwrite client layer)
(Migration: all `src/lib/supabase/` files removed, `src/lib/appwrite/` created)

### Requirement: Supabase RLS Policies

(Reason: Appwrite uses document-level permissions + `user_id` filtering instead of SQL-level RLS)
(Migration: each query adds `Query.equal('user_id', userId)` filter)
