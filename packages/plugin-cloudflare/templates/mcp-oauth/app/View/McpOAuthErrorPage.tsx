/** @jsxImportSource @guren/core */
import type { FC } from '@guren/core'

/**
 * The page a visitor gets when the authorize request itself is unusable —
 * scaffolded once by `guren cloudflare:build --mcp-oauth` and yours to edit.
 *
 * These arrivals are routine, not application faults: a query that is
 * malformed, truncated, tampered with, or simply stale, and a consent form
 * submitted after its CSRF token expired. Left to the exception handler they
 * would surface as a 500 with a stack trace in it — alarming, and useless to
 * the person reading it, because the fix is never anything they can do on this
 * page. It is to start again from the client that sent them.
 *
 * **Nothing derived from the request is rendered here.** No provider message,
 * no query parameter, no exception text: all of it is attacker-controllable,
 * and this page is reached by a browser. `title` and `advice` are the
 * caller's own fixed strings.
 *
 * A file of its own rather than a second export beside the consent screen: it
 * is a different document with different styling and no form, and a developer
 * editing the consent screen should not have to scroll past it.
 *
 * See `McpOAuthConsentPage.tsx` for why the `@jsxImportSource` pragma on line
 * 1 is what lets this compile in an app whose `tsconfig` points
 * `jsx: "react-jsx"` at React. Keep it on the first line.
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
