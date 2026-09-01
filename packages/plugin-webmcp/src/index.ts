/**
 * The server entry of `@guren/plugin-webmcp`.
 *
 * The client half is a separate entry (`@guren/plugin-webmcp/client`) and is
 * deliberately not re-exported here: this module reaches the application
 * container, and a page importing the plugin's root to get
 * `registerAgentTools` would drag that into its bundle.
 *
 * **Version claim.** The client entry needs `@guren/core/agent`, which lands
 * in core 1.13.0, and the manifest says exactly that: `^1.13.0` with
 * `compatibility: ">=1.13.0 <2.0.0"`. Both name a version this workspace has
 * not published yet, which `audit:plugin-compat` admits because the pending
 * release plan produces it — see the release-plan allowance in
 * `scripts/smoke/plugin-compat-audit.ts`. Move the two together: the
 * compatibility range has to cover everything the dependency range admits.
 */
export { webMcpPlugin } from './plugin'
export type { WebMcpPluginConfig } from './plugin'
