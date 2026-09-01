/**
 * The server entry of `@guren/plugin-webmcp`.
 *
 * The client half is a separate entry (`@guren/plugin-webmcp/client`) and is
 * deliberately not re-exported here: this module reaches the application
 * container, and a page importing the plugin's root to get
 * `registerAgentTools` would drag that into its bundle.
 *
 * **Open version claim.** The client entry needs `@guren/core/agent`, which
 * lands in core 1.13.0, while this package's manifest declares `^1.12.0` /
 * `compatibility: ">=1.12.0 <2.0.0"`. That is not a mistake but it is not
 * final either: `audit:plugin-compat` checks both claims against the
 * *workspace* core version, which only moves at `changeset version`, so a
 * tighter range cannot be declared before the release that produces it. Once
 * core 1.13.0 has shipped, both should be raised — see the follow-up recorded
 * in the package's initial changeset.
 */
export { webMcpPlugin } from './plugin'
export type { WebMcpPluginConfig } from './plugin'
