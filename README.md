# wacrm — CRM Template for WhatsApp

> Self-hostable CRM template for WhatsApp® — shared inbox, contacts,
> sales pipelines, broadcasts, and no-code automations. Fork it, brand
> it, host it.

[![Deploy on Hostinger](https://img.shields.io/badge/Deploy_on-Hostinger-673DE6?style=for-the-badge&logo=hostinger&logoColor=white)](https://www.hostinger.com/web-apps-hosting)

[![License: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](./LICENSE)
[![CI](https://github.com/ArnasDon/wacrm/actions/workflows/ci.yml/badge.svg)](https://github.com/ArnasDon/wacrm/actions/workflows/ci.yml)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ecf8e?logo=supabase)](https://supabase.com)
[![Stars](https://img.shields.io/github/stars/ArnasDon/wacrm?style=social)](https://github.com/ArnasDon/wacrm/stargazers)

The marketing site and self-host docs live in a separate repo:
[ArnasDon/wacrm-site](https://github.com/ArnasDon/wacrm-site)
([wacrm.tech](https://wacrm.tech)). This repo is the product —
clone or fork it to run your own CRM.

## What you get out of the box

- **Shared inbox** on the official WhatsApp Business API — multiple
  agents working one number, per-conversation assignment, status, and
  notes.
- **Contacts + tags + custom fields**, CSV import, deduplication.
- **Sales pipelines** (Kanban) with deals linked to conversations.
- **Broadcasts** with Meta-approved templates, delivery + read
  tracking, per-recipient variable substitution.
- **No-code automations** — triggers on inbound messages, new
  contacts, keywords, or schedule; conditional branches, waits,
  tags, webhooks. Visual builder.
- **Real-time dashboard** — response times, daily volume, pipeline
  value, cross-module activity feed.
- **Account management** — email, password, avatar, global sign-out.

## Why fork this?

This is a **template**, not a product. Forking means you get:

- **Full ownership** — your code, your Supabase project, your domain,
  your data. No SaaS lock-in, no seat pricing, no trust dance.
- **Full customisation** — add the fields your team needs, remove the
  modules you don't, redesign anything. The stack is boring on
  purpose (Next.js + Supabase + Tailwind) so the learning curve is
  short.
- **Zero ops to start** — Hostinger Managed Node.js deploys a fork in
  a few clicks. No Docker, no Kubernetes, no infra team needed.
- **Real security primitives** — token encryption (AES-256-GCM), RLS
  on every table, HMAC-verified webhooks, CSP, rate limiting, CI
  typecheck/build on every PR.

Not a framework. Not an SDK. A concrete, working CRM you can stand up
in an afternoon and make yours.

## Quick start

```bash
# Fork on GitHub first: https://github.com/ArnasDon/wacrm → Fork
git clone https://github.com/<your-username>/wacrm.git
cd wacrm
npm install
cp .env.local.example .env.local   # fill in Supabase + Meta creds
npm run dev
```

Open <http://localhost:3000>. You'll be redirected to `/login` (or
`/dashboard` if already signed in).

## Documentation

Full self-host documentation — Supabase migrations, WhatsApp Business
API config, and production deploy — lives at
**[wacrm.tech/docs](https://wacrm.tech/docs)**
(source: [ArnasDon/wacrm-site](https://github.com/ArnasDon/wacrm-site)).

Key pages:
- [Getting started](https://wacrm.tech/docs/getting-started)
- [Supabase setup](https://wacrm.tech/docs/supabase-setup)
- [WhatsApp setup](https://wacrm.tech/docs/whatsapp-setup)
- [Environment variables](https://wacrm.tech/docs/environment-variables)
- [Deploy on Hostinger](https://wacrm.tech/docs/deployment-hostinger)
- [Architecture](https://wacrm.tech/docs/architecture)
- [Troubleshooting](https://wacrm.tech/docs/troubleshooting)

## Stack

- **App** — Next.js 16 (App Router), React 19, TypeScript, Tailwind v4.
- **Data** — Supabase (Postgres + Auth + Storage + RLS).
- **WhatsApp** — Meta Cloud API (official WhatsApp Business API).

## Contributing

This is a template, not a collaborative product — the expected flow is
fork → customise → deploy, **not** upstream contribution. Bug reports
and security issues are welcome; feature PRs often belong in your fork
rather than here. Details in
[`CONTRIBUTING.md`](./CONTRIBUTING.md) and
[`.github/SECURITY.md`](./.github/SECURITY.md).

## Engram Cloud (Memory Sync)

Engram provides persistent memory for AI coding agents across sessions.
This project uses a self-hosted Engram Cloud instance for cross-machine memory sync.

### Server (already configured)

- **URL**: `https://engram-cloud-engram-cloud.fjueze.easypanel.host`
- **Project**: `wacrm`
- **Dashboard**: `https://engram-cloud-engram-cloud.fjueze.easypanel.host/dashboard`

### Client setup (new machine)

```powershell
# 1. Configure the cloud server
engram cloud config --server https://engram-cloud-engram-cloud.fjueze.easypanel.host

# 2. Set the auth token (persist permanently)
[Environment]::SetEnvironmentVariable("ENGRAM_CLOUD_TOKEN", "<token>", "User")

# 3. Enroll this project
engram cloud enroll wacrm

# 4. First sync
engram sync --cloud --project wacrm
```

### Daily usage

```powershell
# Sync after a work session
engram sync --cloud --project wacrm

# Import from cloud on a fresh clone
engram sync --cloud --import --project wacrm

# Check sync status
engram sync --cloud --status --project wacrm
```

### Enrolled projects

All projects are synced to the cloud:

| Project | Observations |
|---------|--------------|
| wacrm | 2 |
| grupo-ecotech | 28 |
| teachpadah-landingpage-1 | 20 |
| pago_prestamos | 10 |
| business-os-new | 7 |
| leonard-seguros | 5 |
| agente-omnicanal | 4 |
| omni-crm | 3 |
| sidebar-gemini | 3 |

To sync a new project:

```powershell
engram cloud enroll <project-name>
engram sync --cloud --project <project-name>
```

> Local SQLite remains the source of truth. Cloud is opt-in replication only.

## License

[MIT](./LICENSE). Fork it, brand it, host it.
