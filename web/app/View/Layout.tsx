/** @jsxImportSource @guren/core */
import { viteAsset, type FC, type PropsWithChildren } from '@guren/core'
import {
  COLOR_MODE_PREPAINT_SCRIPT,
  FAVICON_LINKS,
  LIGHT_SURFACE_CRITICAL_CSS,
} from '../../config/document-theme.js'
import { LIGHT_SURFACE_BODY_CLASS } from '../../config/theme.js'
import { SITE_NAME, absoluteUrl } from '../../config/site.js'

/**
 * Document skeleton for server-rendered content pages, from the same `config/`
 * modules as `setInertiaDocument()` so the two cannot drift. The `<head>`
 * carries only what pages never restate, since hono's metadata hoisting appends
 * rather than replaces; page metadata arrives through the `head` slot, whose
 * tags skip the hoisting pass (measured quadratic in tag count, ~1 ms per view).
 */
export const Layout: FC<PropsWithChildren<{ head?: unknown }>> = ({ head, children }) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style dangerouslySetInnerHTML={{ __html: LIGHT_SURFACE_CRITICAL_CSS }} />
      <script dangerouslySetInnerHTML={{ __html: COLOR_MODE_PREPAINT_SCRIPT }} />
      {FAVICON_LINKS.map((link) => (
        <link rel={link.rel} type={'type' in link ? link.type : undefined} sizes={link.sizes} href={link.href} />
      ))}
      <link
        rel="alternate"
        type="application/rss+xml"
        title={`${SITE_NAME} Blog`}
        href={absoluteUrl('/blog/rss.xml')}
      />
      <link rel="stylesheet" href={viteAsset('resources/css/app.css')} />
      {head as never}
    </head>
    <body class={LIGHT_SURFACE_BODY_CLASS}>{children as never}</body>
  </html>
)
