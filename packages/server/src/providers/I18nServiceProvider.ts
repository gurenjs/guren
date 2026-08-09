import type { Context } from 'hono'
import { ServiceProvider } from '../container/ServiceProvider'
import { createI18n, type I18nManager, type TranslationMessages } from '../i18n'
import { detectLocaleMiddleware, getRequestLocale } from '../http/middleware/detect-locale'
import { shareInertiaProps } from '../mvc/inertia/shared'
import type { Application, I18nPluginOptions } from '../http/Application'

/**
 * Shape of the `_i18n` Inertia shared prop injected when `createApp({ i18n })`
 * is configured (unless `i18n.share` is `false`). The client-side
 * `useTranslation()` hook consumes this.
 */
export interface InertiaI18nProps {
  locale: string
  fallbackLocale: string
  messages: Record<string, TranslationMessages>
}

/**
 * Binds the I18nManager as a singleton in the container.
 *
 * When the app is created with `createApp({ i18n })`, this provider also
 * mounts locale detection middleware (unless `i18n.detect` is `false`),
 * preloads every supported locale during boot, and shares the request locale
 * and its messages with Inertia pages as the `_i18n` prop (unless
 * `i18n.share` is `false`).
 */
export class I18nServiceProvider extends ServiceProvider {
  register(): void {
    const app = this.application()
    const options = app?.i18nOptions

    if (options) {
      if (options.supported.length === 0) {
        throw new Error('createApp({ i18n }) requires at least one supported locale.')
      }
      if (options.fallback && !options.supported.includes(options.fallback)) {
        throw new Error(
          `createApp({ i18n }): fallback locale '${options.fallback}' must be one of the supported locales (${options.supported.join(', ')}).`,
        )
      }
    }

    this.container.singleton('i18n', () => {
      if (!options) {
        return createI18n({ locale: 'en' })
      }

      const fallback = options.fallback ?? options.supported[0]!
      return createI18n({
        locale: fallback,
        fallbackLocale: fallback,
        path: options.loader ? undefined : options.path ?? 'lang',
        loader: options.loader,
      })
    })

    if (app && options && options.detect !== false) {
      const manager = this.container.make<I18nManager>('i18n')
      app.use('*', detectLocaleMiddleware({
        ...options.detect,
        supported: options.supported,
        fallback: manager.getLocale(),
        i18n: manager,
      }))
    }
  }

  async boot(): Promise<void> {
    const options = this.application()?.i18nOptions
    if (!options) return

    const manager = this.container.make<I18nManager>('i18n')
    await manager.loadLocales([...options.supported])

    // A missing lang directory or unparseable file surfaces as an empty
    // catalog rather than a boot failure (JsonLoader tolerates both) — warn
    // so a broken path is visible instead of silently untranslated.
    for (const locale of options.supported) {
      if (Object.keys(manager.getMessages(locale)).length === 0) {
        console.warn(
          `[guren] i18n: no translations loaded for locale '${locale}'` +
          (options.loader ? '.' : ` — expected ${options.path ?? 'lang'}/${locale}/*.json.`),
        )
      }
    }

    if (options.share !== false) {
      const fallback = manager.getFallbackLocale() ?? manager.getLocale()
      const supported = new Set(options.supported)

      // Props are built once per supported locale; messages added to the
      // manager after a locale is cached are not picked up — same load-once
      // lifecycle as the locale middleware's translators. Locales outside
      // `supported` (a custom middleware setting an unvalidated `locale`
      // context variable) are served uncached so the map stays bounded.
      const propsByLocale = new Map<string, InertiaI18nProps>()

      shareInertiaProps((ctx: Context) => {
        const locale = getRequestLocale(ctx) ?? fallback

        let i18nProps = propsByLocale.get(locale)
        if (!i18nProps) {
          i18nProps = {
            locale,
            fallbackLocale: fallback,
            messages: manager.messagesForLocale(locale),
          }
          if (supported.has(locale)) {
            propsByLocale.set(locale, i18nProps)
          }
        }

        return { _i18n: i18nProps }
      })
    }
  }

  /** The provider works standalone on a bare container (no `app` binding). */
  private application(): Application | undefined {
    return this.container.has('app') ? this.container.make<Application>('app') : undefined
  }
}
