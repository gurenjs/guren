// Markup inlined into the server-rendered document `<head>`. Imported only by
// `src/app.ts` — keeping these strings out of `theme.ts` keeps them out of the
// client bundle, where they would ship on every page and never be read.

import { COLOR_MODE_STORAGE_KEY, LIGHT_SURFACE_BODY_CLASS } from './theme.js'

/**
 * Surface and text colors for the first paint, inlined ahead of the stylesheet
 * links. Duplicates the `--docs-surface-page` / `--docs-text-primary` values
 * from `resources/css/app.css` — CSS custom properties cannot be read from TS,
 * so retheming the docs surface means editing both files.
 */
const SURFACE_CSS = `
html,body{background:#ffffff;color:#1f2937;}
body.${LIGHT_SURFACE_BODY_CLASS}{background:#ffffff;color:#1f2937;}
html.dark,html.dark body,html.dark body.${LIGHT_SURFACE_BODY_CLASS}{background:#1a1a2e;color:#e0def4;}
`

/** Tailwind `size-*` utilities the generated stylesheet does not always emit. */
const SIZE_UTILITIES = `
.size-4{width:1rem;height:1rem;}
.size-5{width:1.25rem;height:1.25rem;}
.size-6{width:1.5rem;height:1.5rem;}
.size-8{width:2rem;height:2rem;}
.size-9{width:2.25rem;height:2.25rem;}
`

export const LIGHT_SURFACE_CRITICAL_CSS = `${SURFACE_CSS}${SIZE_UTILITIES}`

/**
 * Resolves the color mode before the first paint, so a dark-mode reader never
 * sees a light flash. Mirrors `applyMode()` in
 * `resources/js/pages/Docs/theme.ts` — the two must agree, and nothing but this
 * comment enforces that.
 */
export const COLOR_MODE_PREPAINT_SCRIPT = `(function(){
  try{
    var mode = localStorage.getItem('${COLOR_MODE_STORAGE_KEY}') || 'system';
    var dark = mode === 'dark' || (mode !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
  }catch(_){}
})();`
