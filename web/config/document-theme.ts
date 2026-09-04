// Markup inlined into the server-rendered document `<head>`, by `src/app.ts`
// and `app/View/Layout.tsx` — both server-only. Kept out of `theme.ts` so these
// strings stay out of the client bundle, where they would never be read.

import { COLOR_MODE_STORAGE_KEY, LIGHT_SURFACE_BODY_CLASS } from './theme.js'

/**
 * Surface and text colors for the first paint, inlined ahead of the stylesheet
 * links. Duplicates `--docs-surface-page` / `--docs-text-primary` from
 * `resources/css/app.css`, which TS cannot read: retheme both files.
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
 * Favicon links, site-wide; the framework has no default. The structured form
 * is the source of truth — the Inertia document consumes the derived string,
 * `app/View/Layout.tsx` maps the same array to elements.
 */
export const FAVICON_LINKS = [
  { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32x32.png' },
  { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/favicon-192x192.png' },
  { rel: 'icon', type: 'image/png', sizes: '512x512', href: '/favicon-512x512.png' },
  { rel: 'apple-touch-icon', sizes: '192x192', href: '/favicon-192x192.png' },
] as const

export const FAVICON_HEAD = FAVICON_LINKS.map(
  (link) =>
    `<link rel="${link.rel}"${'type' in link ? ` type="${link.type}"` : ''} sizes="${link.sizes}" href="${link.href}" />`,
).join('\n')

/**
 * Resolves the color mode before the first paint, so a dark-mode reader never
 * sees a light flash. Must agree with `applyMode()` in
 * `resources/js/pages/Docs/theme.ts`; nothing but this comment enforces that.
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


/**
 * The click-to-toggle counterpart to the prepaint script above, inlined by
 * `app/View/Header.tsx`. Semantics must match the React toggle: a click
 * collapses `system` into an explicit `light`/`dark`, and while the mode is
 * `system` an OS theme change is followed live through `matchMedia`.
 */
export const COLOR_MODE_TOGGLE_SCRIPT = `(function(){
  var root = document.documentElement;
  function apply(dark){
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
  }
  function stored(){
    try { return localStorage.getItem('${COLOR_MODE_STORAGE_KEY}') || 'system'; } catch(_) { return 'system'; }
  }
  var button = document.getElementById('color-mode-toggle');
  function label(){
    if (button) button.setAttribute('aria-label', root.classList.contains('dark') ? 'Switch to light mode' : 'Switch to dark mode');
  }
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (media && media.addEventListener) {
    media.addEventListener('change', function(event){
      if (stored() === 'system') { apply(event.matches); label(); }
    });
  }
  if (button) {
    button.addEventListener('click', function(){
      var dark = !root.classList.contains('dark');
      try { localStorage.setItem('${COLOR_MODE_STORAGE_KEY}', dark ? 'dark' : 'light'); } catch(_) {}
      apply(dark);
      label();
    });
  }
  label();
})();`
