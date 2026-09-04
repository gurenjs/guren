/** @jsxImportSource @guren/core */
import type { FC } from '@guren/core'

/**
 * The page a visitor gets when the authorize request itself is unusable —
 * scaffolded once by `guren cloudflare:build --mcp-oauth` and yours to edit.
 * These arrivals are routine (a malformed, stale or tampered query, an expired
 * CSRF token) and would otherwise surface as a 500 with a stack trace.
 *
 * **Nothing derived from the request is rendered here**: a provider message, a
 * query parameter or an exception text is attacker-controllable and a browser
 * reads this page, so `title` and `advice` are the caller's fixed strings. The
 * `@jsxImportSource` pragma lets this compile in an app whose `tsconfig` points
 * `jsx: "react-jsx"` at React — keep it on line 1, the only place it counts.
 */
export interface McpOAuthErrorPageProps {
  /** What went wrong, in the visitor's terms. A fixed string, never echoed input. */
  title: string
  /** What to do about it. Also fixed. */
  advice: string
}

const STYLES = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0 auto; max-width: 32rem; padding: 3rem 1rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; }
  p { opacity: .8; }
`

export const McpOAuthErrorPage: FC<McpOAuthErrorPageProps> = ({ title, advice }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style>{STYLES}</style>
    </head>
    <body>
      <h1>{title}</h1>
      <p>{advice}</p>
    </body>
  </html>
)

export default McpOAuthErrorPage
