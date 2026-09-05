/**
 * The server entry of `@guren/plugin-webmcp`. The client half is a separate
 * entry (`@guren/plugin-webmcp/client`), not re-exported: this module reaches
 * the application container, which a page importing the root would bundle.
 * The client needs `@guren/core/agent` (core 1.13.0), so `gurenPlugin.compatibility`
 * says `">=1.13.0 <2.0.0"` while the dependency range stays `^1.12.0`: bun links
 * a workspace dependency only through a range admitting the version on disk, and
 * a `^1.13.0` floor falls through to npm, where `--frozen-lockfile` fails.
 * `changeset version` raises the floor, `audit:plugin-compat` knows (`rangeAtRelease`): never hand-edit.
 */
export { webMcpPlugin } from './plugin'
export type { WebMcpPluginConfig } from './plugin'
