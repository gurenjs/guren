/**
 * The server half of `@guren/plugin-webmcp` (RFC 0016 §7, Phase 3).
 *
 * WebMCP runs entirely in the page, so this half does almost nothing — and
 * that is the point rather than an oversight. It exists for two reasons a
 * client-only package could not cover:
 *
 * - **The origin trial.** Chrome gates `modelContext` behind an origin trial,
 *   and a trial token is only honoured when the *application* serves it, as a
 *   response header or a page `<meta>`. Only something inside the server can
 *   do that, so `webMcpPlugin({ originTrial })` is where an app says it once
 *   instead of threading a header through every route.
 * - **Installation.** `guren plugin @guren/plugin-webmcp` installs a package,
 *   checks its `gurenPlugin.compatibility` against the app's `@guren/core`,
 *   and expects a provider to register. A package with a client entry alone
 *   would install through that flow and then have nothing to add to
 *   `createApp({ providers })`, which reads as a broken install.
 *
 * With no options it registers no middleware at all: an identity provider,
 * which is the honest shape for "the browser does the work".
 */
import { definePlugin, defineMiddleware, type Application, type ServiceProviderConstructor } from '@guren/core'

export interface WebMcpPluginConfig {
  /**
   * A Chrome origin-trial token for the WebMCP API, served as `Origin-Trial`
   * on every response.
   *
   * Appended rather than set: an app may already serve tokens for other
   * trials, and one `Origin-Trial` header per token is how the browser reads
   * several. Overwriting would silently disable whichever trial was there
   * first.
   */
  originTrial?: string
}

const factory = definePlugin<WebMcpPluginConfig>({
  name: 'webmcp',
  register(container, config): void {
    if (!config.originTrial) return

    const token = config.originTrial
    // In `register`, not `boot`: providers register before the router mounts,
    // and Hono only runs middleware against routes registered after it. A
    // global middleware added at boot would apply to nothing the app
    // declared.
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
 *
 * @example
 * ```typescript
 * import { webMcpPlugin } from '@guren/plugin-webmcp'
 *
 * createApp({ providers: [webMcpPlugin({ originTrial: process.env.WEBMCP_ORIGIN_TRIAL })] })
 * ```
 */
export function webMcpPlugin(config: WebMcpPluginConfig = {}): ServiceProviderConstructor {
  return factory(config)
}
