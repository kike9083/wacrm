"use client"

import Link from 'next/link'
import { UserPlus, Briefcase, Radio, Zap } from 'lucide-react'
import type { ComponentType } from 'react'
import { useTranslation } from 'react-i18next'

// Quick-action shortcuts. Each navigates to the page that owns the
// relevant "create" flow. We deliberately don't try to auto-open any
// modal on the target page — that'd require touching those pages,
// which is out of scope here.
interface Action {
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
  tint: string
}

export function QuickActions() {
  const { t } = useTranslation()

  const actions: Action[] = [
    { label: t('dashboard.quickActions.newContact'), href: '/contacts', icon: UserPlus, tint: 'text-primary' },
    { label: t('dashboard.quickActions.newDeal'), href: '/pipelines', icon: Briefcase, tint: 'text-blue-400' },
    { label: t('dashboard.quickActions.sendBroadcast'), href: '/broadcasts/new', icon: Radio, tint: 'text-amber-400' },
    { label: t('dashboard.quickActions.newAutomation'), href: '/automations/new', icon: Zap, tint: 'text-primary' },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {actions.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.href}
            href={a.href}
            className="group flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 transition-colors hover:border-slate-700 hover:bg-slate-800/60"
          >
            <div className={`flex h-9 w-9 items-center justify-center rounded-lg bg-slate-800 ${a.tint}`}>
              <Icon className="h-4 w-4" />
            </div>
            <span className="text-sm font-medium text-white">{a.label}</span>
          </Link>
        )
      })}
    </div>
  )
}
