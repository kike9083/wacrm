---
name: saas-factory-v4
description: "SaaS Factory V4 Golden Path, feature-first architecture, and agent-first software building workflows. Trigger: building B2B/B2C SaaS, setting up Next.js 16, Appwrite database/collections, React 19 components, Tailwind styling, or adding Playwright QA."
license: MIT
metadata:
  author: gentleman-programming
  version: "4.0"
---

# SaaS Factory V4 — Agent-First Software Building

This skill defines the Golden Path, architecture, and execution workflows of SaaS Factory V4 to build modern, production-ready SaaS applications.

---

## When to Use

Load this skill whenever you are:
- Designing or architecting a new SaaS application or feature.
- Creating Next.js 16 (App Router) pages or layouts.
- Structuring components, services, or stores under a Feature-First model.
- Setting up Appwrite collections, documents, or document security permissions.
- Planning complex development phases (PRPs) or writing Playwright E2E tests.

---

## The Golden Path Stack

No ad-hoc technical decisions. Adhere strictly to this stack:

| Layer | Technology | Key Constraints |
|---|---|---|
| **Framework** | Next.js 16 + React 19 + TypeScript | App Router, Server Actions, Strict Mode |
| **Styling** | Vanilla Tailwind CSS 3.4 | Curated harmonized palettes, smooth transitions |
| **Backend** | Appwrite (Auth + Databases + Storage) | Standard client/server initializers, active permissions |
| **State** | Zustand | Light global stores, colocalized to features |
| **Validation** | Zod | Strictly validate client-side forms and Server Action inputs |
| **Testing** | Playwright CLI | E2E automation before declaring success |
| **Deployment** | Vercel | Clean environmental variables mapping |

---

## Feature-First Architecture

Organize all code by feature domains to keep files colocalized and highly maintainable:

```
src/
├── app/                    # Next.js App Router routes & layouts
│   ├── (auth)/            # Auth routes (login, signup, reset)
│   ├── (main)/            # Main layout with sidebar/dashboard
│   └── api/               # API endpoints
├── features/              # Feature directories
│   └── [feature-name]/
│       ├── components/    # Feature-specific UI components
│       ├── hooks/         # React hooks containing feature logic
│       ├── services/      # Appwrite collections/databases interaction
│       ├── types/         # TypeScript declarations
│       └── store/         # Zustand state stores
└── shared/                # Globally shared code
    ├── components/        # Reusable UI (buttons, cards, dialogs)
    ├── hooks/             # Shared React hooks
    ├── lib/               # Shared initializers (appwrite/client, appwrite/server)
    └── types/             # Reusable domain types
```

---

## Core Development Loop

Follow these steps for any new feature or project initialization:

1. **Negocio (`new-app`)**: Interview the user to extract business rules and save them in `BUSINESS_LOGIC.md`.
2. **Diseño Visual**: Select a harmonized visual system (e.g., Neobrutalism, Liquid Glass) with tailored dark/light color schemes.
3. **Planificación (`prp`)**: Generate a Product Requirements Proposal (`.claude/PRPs/prp-[feature].md`) detailing objective, success criteria, and strict phases.
4. **Implementación (`bucle-agentico`)**: Execute implementation phase-by-phase, ensuring auto-blindaje (learning from bugs).
5. **QA (`playwright-cli`)**: Execute Playwright CLI to verify correct happy path and edge cases. Generate `.qa-reports/`.

---

## Critical Code Rules

- **KISS, YAGNI, DRY**: Keep it extremely simple, don't over-engineer, and don't duplicate.
- **Size Limits**: Maximum 500 lines per file; maximum 50 lines per function.
- **Safety First**: Never use `any` (use `unknown`), strictly validate with Zod, and configure document-level permissions in Appwrite.
- **Clean CWD**: Do not run commands outside the workspace or hardcode ports (rely on auto-detection).
