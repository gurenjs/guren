import { defineModule } from '@guren/server'
import WidgetProvider from './app/Providers/WidgetProvider.js'
import { registerWidgetRoutes } from './routes.js'

// The module's public surface — the only import path an app's arch rules allow.
export { listWidgets, type Widget } from './app/Services/widgets.js'

export const widgetModule = defineModule({
  name: 'widgets',
  routes: registerWidgetRoutes,
  providers: [WidgetProvider],
})
