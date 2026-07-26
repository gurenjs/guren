import { ServiceProvider } from '@guren/server'

export default class WidgetProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('widgets', () => ({ enabled: true }))
  }
}
