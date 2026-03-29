import { ServiceProvider } from '../container/ServiceProvider'
import { createI18n } from '../i18n'

/**
 * Binds the I18nManager as a singleton in the container.
 */
export class I18nServiceProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('i18n', () => createI18n({ locale: 'en' }))
  }
}
