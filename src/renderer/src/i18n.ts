import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import en from './locales/en.json'
import it from './locales/it.json'
import ru from './locales/ru.json'
import fa from './locales/fa.json'
import ar from './locales/ar.json'
import zh from './locales/zh.json'
import es from './locales/es.json'
import de from './locales/de.json'
import fr from './locales/fr.json'

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      it: { translation: it },
      ru: { translation: ru },
      fa: { translation: fa },
      ar: { translation: ar },
      zh: { translation: zh },
      es: { translation: es },
      de: { translation: de },
      fr: { translation: fr }
    },
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage']
    }
  })

export default i18n
