/**
 * The server half of `@guren/plugin-webmcp` (RFC 0016 §7, Phase 3).
 *
 * WebMCP runs entirely in the page, so this half exists for two reasons a
 * client-only package could not cover: Chrome gates `modelContext` behind an
 * origin trial whose token is only honoured when the *application* serves it,
 * and `guren plugin @guren/plugin-webmcp` expects a provider to register — a
 * package with no provider reads as a broken install. With no options it
 * registers no middleware at all.
 */
import { definePlugin, defineMiddleware, type Application, type ServiceProviderConstructor } from '@guren/core'

export interface WebMcpPluginConfig {
  /**
   * A Chrome origin-trial token for the WebMCP API, served as `Origin-Trial`
   * on every response. Appended rather than set: one header per token is how
   * the browser reads several trials, and overwriting would silently disable
   * whichever trial was there first.
   */
  originTrial?: string
}

const factory = definePlugin<WebMcpPluginConfig>({
  name: 'webmcp',
  register(container, config): void {
    if (!config.originTrial) return

    const token = config.originTrial
    // In `register`, not `boot`: providers register before the router mounts,
    // and Hono only runs middleware against routes registered after it.
    const app = container.make<Application>('app')
    app.use(
      '*',
      defineMiddleware(async (c, next) => {
        await next()
        c.header('Origin-Trial', token, { append: true })
      }),
    )
  },
})

/**
 * Register the WebMCP plugin.
 * @example createApp({ providers: [webMcpPlugin({ originTrial: token })] })
 */
export function webMcpPlugin(config: WebMcpPluginConfig = {}): ServiceProviderConstructor {
  return factory(config)
}
