/** @jsxImportSource @guren/core */
import { viteAsset, type FC, type PropsWithChildren } from '@guren/core'
import {
  COLOR_MODE_PREPAINT_SCRIPT,
  LIGHT_SURFACE_CRITICAL_CSS,
} from '../../config/document-theme.js'
import { LIGHT_SURFACE_BODY_CLASS } from '../../config/theme.js'

/**
 * Document skeleton for server-rendered content pages (`Controller.view()`,
 * RFC 0014). Mirrors what `setInertiaDocument()` assembles for Inertia pages
 * in `src/app.ts` — same critical CSS, prepaint script, favicons, and body
 * class, imported from the same `config/` modules so the two documents
 * cannot drift.
 *
 * The `<head>` carries only what pages never restate (hono's metadata
 * hoisting appends rather than replaces): charset, viewport, the theme
 * bootstrap, favicons, and the stylesheet. `<title>`, descriptions, and
 * canonical links belong to the page — see `Seo.tsx`.
 */

/** Icon show/hide for the color-mode toggle; keyed off `html.dark` like the CSS theme. */
const COLOR_MODE_ICON_CSS =
  '.cm-sun{display:none}.cm-moon{display:block}html.dark .cm-sun{display:block}html.dark .cm-moon{display:none}'

export const Layout: FC<PropsWithChildren> = ({ children }) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style
        dangerouslySetInnerHTML={{ __html: LIGHT_SURFACE_CRITICAL_CSS + COLOR_MODE_ICON_CSS }}
      />
      <script dangerouslySetInnerHTML={{ __html: COLOR_MODE_PREPAINT_SCRIPT }} />
      {/* Mirrors FAVICON_HEAD in config/document-theme.ts (an HTML string the
          Inertia document inlines; JSX form here). */}
      <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
      <link rel="icon" type="image/png" sizes="192x192" href="/favicon-192x192.png" />
      <link rel="icon" type="image/png" sizes="512x512" href="/favicon-512x512.png" />
      <link rel="apple-touch-icon" sizes="192x192" href="/favicon-192x192.png" />
      <link rel="stylesheet" href={viteAsset('resources/css/app.css')} />
    </head>
    <body class={LIGHT_SURFACE_BODY_CLASS}>{children as never}</body>
  </html>
)
