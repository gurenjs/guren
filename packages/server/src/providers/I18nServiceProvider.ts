import type { Context } from 'hono'
import { ServiceProvider } from '../container/ServiceProvider'
import { createI18n, type I18nManager, type TranslationMessages } from '../i18n'
import { detectLocaleMiddleware, LOCALE_CONTEXT_KEY } from '../http/middleware/detect-locale'
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

    if (options && options.supported.length === 0) {
      throw new Error('createApp({ i18n }) requires at least one supported locale.')
    }

    this.container.singleton('i18n', () => {
      if (!options) {
        return createI18n({ locale: 'en' })
      }

      const fallback = resolveFallback(options)
      return createI18n({
        locale: fallback,
        fallbackLocale: fallback,
        path: options.loader ? undefined : options.path ?? 'lang',
        loader: options.loader,
        messages: options.messages,
      })
    })

    if (app && options && options.detect !== false) {
      app.use('*', detectLocaleMiddleware({
        fallback: resolveFallback(options),
        ...options.detect,
        supported: options.supported,
        i18n: this.container.make<I18nManager>('i18n'),
      }))
    }
  }

  async boot(): Promise<void> {
    const options = this.application()?.i18nOptions
    if (!options) return

    const manager = this.container.make<I18nManager>('i18n')
    await manager.loadLocales([...options.supported])

    if (options.share !== false) {
      const fallback = resolveFallback(options)

      shareInertiaProps((ctx: Context) => {
        const requestLocale = (ctx.var as Record<string, unknown> | undefined)?.[LOCALE_CONTEXT_KEY]
        const locale =
          typeof requestLocale === 'string' && requestLocale.length > 0 ? requestLocale : fallback

        // Insertion order matters to the client: fallback first so the
        // active locale's messages win on key collisions when flattened.
        const messages: Record<string, TranslationMessages> = {}
        if (fallback !== locale) {
          messages[fallback] = manager.getMessages(fallback)
        }
        messages[locale] = manager.getMessages(locale)

        const i18nProps: InertiaI18nProps = { locale, fallbackLocale: fallback, messages }
        return { _i18n: i18nProps }
      })
    }
  }

  /** The provider works standalone on a bare container (no `app` binding). */
  private application(): Application | undefined {
    return this.container.has('app') ? this.container.make<Application>('app') : undefined
  }
}

function resolveFallback(options: I18nPluginOptions): string {
  return options.fallback ?? options.supported[0]!
}
