import type { TranslationLoader, TranslationMessages } from '../types'

/**
 * In-memory translation loader.
 * Useful for testing or when translations are bundled with the application.
 */
export class MemoryLoader implements TranslationLoader {
  private messages: Record<string, TranslationMessages>

  constructor(messages: Record<string, TranslationMessages> = {}) {
    this.messages = messages
  }

  /**
   * Load all translations for a locale.
   */
  async load(locale: string): Promise<TranslationMessages> {
    return this.messages[locale] ?? {}
  }

  /**
   * Load translations for a specific namespace.
   */
  async loadNamespace(locale: string, namespace: string): Promise<TranslationMessages> {
    const localeMessages = this.messages[locale]
    if (!localeMessages) return {}

    const namespaceMessages = localeMessages[namespace]
    if (typeof namespaceMessages === 'object' && namespaceMessages !== null) {
      return namespaceMessages as TranslationMessages
    }

    return {}
  }

  /**
   * Get available locales.
   */
  async getAvailableLocales(): Promise<string[]> {
    return Object.keys(this.messages)
  }

  /**
   * Add messages for a locale.
   */
  addMessages(locale: string, messages: TranslationMessages): void {
    this.messages[locale] = {
      ...this.messages[locale],
      ...messages,
    }
  }

  /**
   * Set messages for a locale (replaces existing).
   */
  setMessages(locale: string, messages: TranslationMessages): void {
    this.messages[locale] = messages
  }

  /**
   * Remove messages for a locale.
   */
  removeLocale(locale: string): void {
    delete this.messages[locale]
  }

  /**
   * Clear all messages.
   */
  clear(): void {
    this.messages = {}
  }
}
