/** @jsxImportSource @guren/core */
import { CSRF_FORM_FIELD, type DerivedAgentTool, type FC } from '@guren/core'

/**
 * The OAuth consent screen for this application's own agent tools, scaffolded
 * once by `guren cloudflare:build --mcp-oauth` and yours to edit from here.
 * Server-rendered through `Controller.view()` (RFC 0014) — `hono/jsx`, no
 * hydration, deliberately not Inertia: an API-only app has no client build, and
 * the browser popup showing this may not carry the cookies an SPA boot needs.
 * Keep the `@jsxImportSource` pragma on line 1, the only place TypeScript
 * honours it: it is what lets this compile, with no tsconfig change, in an app
 * pointing `jsx: "react-jsx"` at React.
 *
 * `hono/jsx` escapes text children and attribute values but does not validate
 * URL schemes, so nothing user-supplied may be added as an `href` unsanitized.
 * The screen lists *tools*, not scopes — nobody can look at `tools:*` and say
 * what it reaches — expanded by the controller into one checkbox each.
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
 * One tool, as a checkbox. The value is the `tool:<name>` wire form the scope
 * grammar parses: `parseToolScope` ignores a bare tool name, so a screen
 * submitting those would report success and grant nothing.
 */
const ToolRow: FC<{ tool: DerivedAgentTool }> = ({ tool }) => (
  <li>
    <label>
      <input
        type="checkbox"
        name={SCOPE_FIELD}
        value={`tool:${tool.toolName}`}
        // Read-only tools arrive ticked, anything that can write does not:
        // granting a write has to be a decision somebody made, not one they
        // failed to undo.
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
