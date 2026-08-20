import { definePlugin, type ServiceProviderConstructor } from '@guren/core'

import { createMarkdownRenderer, type MarkdownRenderer, type MarkdownRendererOptions } from './renderer'

/** Configuration for the markdown plugin — the renderer options, verbatim. */
export type MarkdownPluginConfig = MarkdownRendererOptions

// Not deferred: constructing the renderer is trivial (the real work happens
// per render), and a deferred service cannot be resolved with a plain
// synchronous `container.make()` until something has awaited its loader.
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
 * @example
 * ```typescript
 * createApp({ providers: [markdownPlugin()] })
 * ```
 */
export function markdownPlugin(config: MarkdownPluginConfig = {}): ServiceProviderConstructor {
  return factory(config)
}

export type { MarkdownRenderer }
