/** @jsxImportSource @guren/core */
import { CSRF_FORM_FIELD, type DerivedAgentTool, type FC } from '@guren/core'

/**
 * The OAuth consent screen for this application's own agent tools, scaffolded
 * once by `guren cloudflare:build --mcp-oauth` and yours to edit from here.
 *
 * Server-rendered through `Controller.view()` (RFC 0014) — `hono/jsx`, no
 * hydration, no client bundle. **Not** an Inertia page, for three reasons in
 * order: an API-only app has no client build to render one into; a consent
 * screen that depends on the asset pipeline is one that breaks when the
 * pipeline does; and the OAuth client showing this is a browser popup that may
 * not carry the session cookies an SPA boot needs.
 *
 * The `@jsxImportSource` pragma on line 1 is what lets this file compile in an
 * app whose `tsconfig` points `jsx: "react-jsx"` at React for `resources/js`.
 * It is per-file and overrides `jsxImportSource` for this module only, so
 * **your app needs no tsconfig change** — the same way `web/app/View/*.tsx`
 * does it. Verified by dropping both components into a stock fullstack app
 * (`jsx: "react-jsx"`, React types installed) and running its own `tsc`: clean
 * with the pragma, eleven errors without it. Keep it on the first line, where
 * it is the only place TypeScript honours it.
 *
 * **Escaping is the renderer's job, not this file's.** Text children and
 * attribute values are escaped by `hono/jsx`, so a client name containing
 * markup cannot break out of either. What it does *not* do is validate URL
 * schemes: a `javascript:` href built from untrusted data would be emitted
 * verbatim. Nothing here renders a user-supplied URL, and nothing added here
 * should without sanitizing it first.
 *
 * **What the screen shows, and why it shows tools rather than scopes.** The
 * endpoint's scope grammar (`tool:<name>`, `tools:read`, `tools:*`,
 * `tools:<prefix>.*`) is compact enough for a client to request and far too
 * compact for a human to consent to: nobody can look at `tools:*` and say what
 * it reaches. The controller expands the requested scopes against the
 * application's live tool derivation and hands the result here, one checkbox
 * per tool, carrying the read-only and approval-required facts each one has.
 */

/** The form field each granted scope is submitted under. */
export const SCOPE_FIELD = 'scope'

/** The form field carrying the original authorize query, re-parsed on POST. */
export const QUERY_FIELD = 'authorize_query'

export interface McpOAuthConsentPageProps {
  /** The client's own registered name, or its id when it registered none. */
  clientName: string
  /** The authorize request's query string, handed back on submit. */
  query: string
  /** The tools this request may grant — already intersected with what it asked for. */
  tools: DerivedAgentTool[]
  /** This request's CSRF token, from `getCsrfToken(ctx)`. */
  csrfToken: string
}

const STYLES = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0 auto; max-width: 42rem; padding: 2rem 1rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; }
  .tools { list-style: none; margin: 1.5rem 0; padding: 0; }
  .tools li { border-top: 1px solid rgba(128,128,128,.35); padding: .75rem 0; }
  .name { font-family: ui-monospace, monospace; font-weight: 600; }
  .desc { display: block; margin: .25rem 0 0 1.75rem; opacity: .8; }
  .badge { border: 1px solid currentColor; border-radius: .5rem; font-size: .75rem; margin-left: .5rem; padding: 0 .4rem; }
  .empty { opacity: .8; }
  button { font: inherit; padding: .5rem 1rem; }
`

/**
 * One tool, as a checkbox.
 *
 * The value is the `tool:<name>` wire form the scope grammar parses. A bare
 * tool name is not a scope: `parseToolScope` ignores every entry outside
 * `tool:` / `tools:`, so a screen submitting bare names would report success
 * and produce a grant that reaches nothing.
 */
const ToolRow: FC<{ tool: DerivedAgentTool }> = ({ tool }) => (
  <li>
    <label>
      <input
        type="checkbox"
        name={SCOPE_FIELD}
        value={`tool:${tool.toolName}`}
        // Read-only tools arrive ticked; anything that can write does not.
        // The default is what most people accept unread, so it is the
        // framework's fail-closed posture rendered as a checkbox: granting a
        // write has to be a decision somebody made, not one they failed to
        // undo.
        checked={tool.annotations.readOnlyHint}
      />
      <span class="name">{tool.toolName}</span>
      {tool.annotations.readOnlyHint ? <span class="badge">read only</span> : null}
      {tool.approval === 'required' ? <span class="badge">approval required</span> : null}
    </label>
    {tool.description ? <span class="desc">{tool.description}</span> : null}
  </li>
)

export const McpOAuthConsentPage: FC<McpOAuthConsentPageProps> = ({
  clientName,
  query,
  tools,
  csrfToken,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Authorize {clientName}</title>
      <style>{STYLES}</style>
    </head>
    <body>
      <h1>
        <strong>{clientName}</strong> is asking to use this application's tools
      </h1>
      <p>
        Approving lets it act as you, through the tools you select. Uncheck anything you would
        rather it could not do.
      </p>
      <form method="post" action="/oauth/authorize">
        <input type="hidden" name={CSRF_FORM_FIELD} value={csrfToken} />
        <input type="hidden" name={QUERY_FIELD} value={query} />
        {tools.length === 0 ? (
          <p class="empty">
            This application requested no tools it can be granted. Nothing here would give it
            access, so there is nothing to approve.
          </p>
        ) : (
          <ul class="tools">
            {tools.map((tool) => (
              <ToolRow key={tool.toolName} tool={tool} />
            ))}
          </ul>
        )}
        {tools.length === 0 ? null : <button type="submit">Approve selected</button>}
      </form>
    </body>
  </html>
)

export default McpOAuthConsentPage
