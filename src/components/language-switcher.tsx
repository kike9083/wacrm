'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { setLanguage } from '@/lib/i18n'
import { Languages } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)

  const current = i18n.language

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label={t('language.select')}
        className="flex h-9 w-9 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
      >
        <Languages className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="min-w-32 bg-slate-900 text-slate-100 ring-slate-700"
      >
        <DropdownMenuItem
          onClick={() => { setLanguage('es'); setOpen(false) }}
          className={current === 'es' ? 'text-primary' : 'text-slate-200'}
        >
          {t('language.es')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => { setLanguage('en'); setOpen(false) }}
          className={current === 'en' ? 'text-primary' : 'text-slate-200'}
        >
          {t('language.en')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
