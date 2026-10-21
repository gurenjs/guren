/**
 * The versions the cf backend is verified against (RFC 0035 §7, Appendix C): what
 * `cloudflare:init` raises package.json to and what `cloudflare:deploy`'s preflight checks.
 */

/** cf refuses to load cloudflare.config.ts on older Node (Appendix C row 10). */
export const CF_NODE_FLOOR = '22.18.0'
/** The Wrangler cf delegates the bundle to (Appendix C row 17). */
export const CF_WRANGLER_FLOOR = '4.136.0'
/** The cf release the backend's argv contract is pinned to. */
export const CF_VERSION = '1.0.0-beta.18'
