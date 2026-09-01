/**
 * The server entry of `@guren/plugin-webmcp`.
 *
 * The client half is a separate entry (`@guren/plugin-webmcp/client`) and is
 * deliberately not re-exported here: this module reaches the application
 * container, and a page importing the plugin's root to get
 * `registerAgentTools` would drag that into its bundle.
 *
 * **Version claim, and why its two halves disagree in-repo.** The client entry
 * needs `@guren/core/agent`, which first exists in core 1.13.0.
 * `gurenPlugin.compatibility` says so (`">=1.13.0 <2.0.0"`); the dependency
 * range deliberately does not, and sits at `^1.12.0` — the version this
 * workspace holds.
 *
 * That is not a compromise, it is the only thing that installs. Bun links a
 * workspace dependency only through a range admitting the version on disk; a
 * `^1.13.0` floor falls through to npm, where 1.13.0 does not exist yet, and
 * `bun install --frozen-lockfile` then fails to resolve the package at all.
 * (It did — that is what turned CI red on the first attempt at an "honest"
 * range.)
 *
 * The floor is raised for the *published* manifest by `changeset version`,
 * which rewrites internal `@guren/*` ranges on any bump under this
 * workspace's `updateInternalDependencies: "patch"`. Measured, not assumed:
 * run against a disposable copy of this workspace it turned `^1.12.0` into
 * `^1.13.0` and left `compatibility` untouched. So compatibility leads the
 * range for exactly one release, `audit:plugin-compat` knows it (see
 * `rangeAtRelease` there), and there is nothing to do at release time — do
 * not hand-edit the range.
 */
export { webMcpPlugin } from './plugin'
export type { WebMcpPluginConfig } from './plugin'
