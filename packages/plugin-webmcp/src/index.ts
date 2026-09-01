/**
 * The server entry of `@guren/plugin-webmcp`.
 *
 * The client half is a separate entry (`@guren/plugin-webmcp/client`) and is
 * deliberately not re-exported here: this module reaches the application
 * container, and a page importing the plugin's root to get
 * `registerAgentTools` would drag that into its bundle.
 */
export { webMcpPlugin } from './plugin'
export type { WebMcpPluginConfig } from './plugin'
