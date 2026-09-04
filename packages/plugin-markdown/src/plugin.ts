import { definePlugin, type ServiceProviderConstructor } from '@guren/core'

import { createMarkdownRenderer, type MarkdownRendererOptions } from './renderer'

/** Configuration for the markdown plugin — the renderer options, verbatim. */
export type MarkdownPluginConfig = MarkdownRendererOptions

// Not deferred: constructing the renderer is trivial, and a deferred service
// cannot be resolved with a synchronous `container.make()` until something has
// awaited its loader.
const factory = definePlugin<MarkdownPluginConfig>({
  name: 'markdown',
  register(container, config) {
    container.singleton('markdown', () => createMarkdownRenderer(config))
  },
})

/**
 * Register the markdown plugin. Binds a configured renderer as the
 * `markdown` container service; resolve it with
 * `container.make<MarkdownRenderer>('markdown')`.
 *
 * @example createApp({ providers: [markdownPlugin()] })
 */
export function markdownPlugin(config: MarkdownPluginConfig = {}): ServiceProviderConstructor {
  return factory(config)
}
