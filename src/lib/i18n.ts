import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import es from '@/locales/es.json'
import en from '@/locales/en.json'

const STORAGE_KEY = 'wacrm.lang'

function detectLanguage(): string {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'es') return saved
  }
  return 'es'
}

i18next.use(initReactI18next).init({
  lng: detectLanguage(),
  fallbackLng: 'es',
  resources: {
    es: { translation: es },
    en: { translation: en },
  },
  interpolation: { escapeValue: false },
  returnNull: false,
})

export function setLanguage(lng: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, lng)
  }
  i18next.changeLanguage(lng)
}

export default i18next
