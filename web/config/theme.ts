// Shared theme constants. Imported by both the server document config and the
// React pages, so keep this module dependency-free and side-effect-free.
//
// Anything only the server needs belongs in `document-theme.ts` instead — this
// module is reachable from the client bundle.

/** localStorage key holding the user's light / dark / system preference. */
export const COLOR_MODE_STORAGE_KEY = 'guren-color-mode'

/**
 * `<body>` class swapping the crimson marketing surface for the light
 * documentation one. Mirrors `body.docs-theme` in `resources/css/app.css`.
 */
export const LIGHT_SURFACE_BODY_CLASS = 'docs-theme'

/** Page components rendered on the light documentation surface. */
const LIGHT_SURFACE_PREFIXES = ['Docs/', 'blog/', 'admin/']

export function usesLightSurface(component: string): boolean {
  return LIGHT_SURFACE_PREFIXES.some((prefix) => component.startsWith(prefix))
}
