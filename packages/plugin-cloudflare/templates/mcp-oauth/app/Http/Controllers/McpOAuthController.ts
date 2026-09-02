/**
 * The OAuth consent screen for this application's own agent tools, scaffolded
 * once by `guren cloudflare:build --mcp-oauth` and yours to edit from here.
 *
 * **What this file owns and what it does not.**
 * `@cloudflare/workers-oauth-provider` runs in front of the worker and owns
 * every other part of the flow: discovery metadata, dynamic client
 * registration, the token endpoint, PKCE, refresh, and the encryption of the
 * `props` a grant carries. It hands back exactly one decision, because it is
 * the only one the provider cannot make — *who is signed in, and what did they
 * agree to*. That is this controller.
 *
 * **The screen is plain server-rendered HTML, not an Inertia page.** Three
 * reasons, in order: an API-only app has no client build to render one into; a
 * consent screen that depends on the asset pipeline is a consent screen that
 * breaks when the pipeline does; and the OAuth client rendering this is a
 * browser popup that may not carry the session cookies an SPA boot needs.
 * Style it however you like — it is a string.
 *
 * **What the screen must show, and why it shows tools rather than scopes.**
 * The endpoint's scope grammar (`tool:<name>`, `tools:read`, `tools:*`,
 * `tools:<prefix>.*`) is compact enough for a client to request and far too
 * compact for a human to consent to: nobody can look at `tools:*` and say what
 * it reaches. So the requested scopes are expanded against this application's
 * *live* tool derivation and rendered one tool per checkbox, with the
 * read-only and approval-required facts each tool carries.
 *
 * **Derived live, never read from a manifest.** `.guren/agents.gen.ts` is a
 * build artifact that can be stale; the router is what actually serves. A
 * consent screen listing a tool the dispatcher would deny — or, far worse,
 * omitting one it would allow — is the one bug this screen cannot have.
 *
 * **The grant is a subset of the request, by construction.** Only a checkbox
 * that appeared in the expansion of what the client asked for is honoured, so
 * a submitted value naming anything else is dropped rather than granted. The
 * provider does not enforce this; a form is user input.
 *
 * **Off Workers this fails at request time, not import time.** `getWorkersEnv`
 * throws when no worker request has captured an env — which is exactly right
 * for a file that also has to be importable by `guren codegen`, `guren check`
 * and your test suite, none of which run on workerd.
 */
import {
  CSRF_FORM_FIELD,
  Controller,
  csrfField,
  deriveAgentTools,
  expandToolScopes,
  verifyCsrfToken,
} from '@guren/core'
import type { Application, DerivedAgentTool } from '@guren/core'
// The lean subpath, deliberately not the root entry: the root also exports
// `buildCloudflareOutput`, so importing from it would pull the deploy
// generator and its node builtins into this app's route graph on every boot
// and into the wrangler bundle on every deploy.
import { getWorkersEnv } from '@guren/plugin-cloudflare/env'
import type { AuthRequest, ClientInfo, OAuthHelpers } from '@cloudflare/workers-oauth-provider'

/**
 * Where an unauthenticated visitor is sent. The consent decision is only
 * meaningful for a signed-in user — change this to your own login path.
 */
const LOGIN_PATH = '/login'

/** The form field each granted scope is submitted under. */
const SCOPE_FIELD = 'scope'

/** The form field carrying the original authorize query, re-parsed on POST. */
const QUERY_FIELD = 'authorize_query'

interface WorkerEnvWithProvider {
  OAUTH_PROVIDER: OAuthHelpers
}

export default class McpOAuthController extends Controller {
  /** GET /oauth/authorize — render the consent screen. */
  async show(): Promise<Response> {
    const userId = await this.auth.id()
    if (userId === null || userId === undefined) {
      return this.redirect(this.loginUrl())
    }

    const provider = this.provider()
    const parsed = await this.parseAuthRequest(provider, this.ctx.req.raw)
    if (parsed instanceof Response) {
      return parsed
    }
    const client = await provider.lookupClient(parsed.clientId)

    return this.html(
      this.consentScreen({
        client,
        clientId: parsed.clientId,
        tools: this.offeredTools(parsed.scope),
        query: new URL(this.ctx.req.url).searchParams.toString(),
      }),
    )
  }

  /** POST /oauth/authorize — record the decision and hand back to the provider. */
  async approve(): Promise<Response> {
    const userId = await this.auth.id()
    if (userId === null || userId === undefined) {
      return this.redirect(this.loginUrl())
    }
    if (typeof userId !== 'string' && typeof userId !== 'number') {
      // The grant carries this id in its props and the endpoint maps it to an
      // AgentPrincipal, which admits a string or a number and nothing else.
      throw new Error('The authenticated user id is neither a string nor a number.')
    }

    // `all: true` is what turns the repeated `scope` checkboxes into an array
    // instead of the last one winning — without it this screen would grant
    // exactly one tool however many boxes were ticked, silently.
    //
    // The CSRF middleware has already called `parseBody()` on this request,
    // with no options, to read the `_token` field. Hono's body cache is keyed
    // on those options rather than on the request alone, so this second call
    // still returns the array. Measured rather than assumed: a cache keyed on
    // the request alone would hand back the middleware's `all: false` result,
    // and the failure would be invisible — no error, no log line, one tool
    // granted. `tests/hono-parse-body.test.ts` in @guren/plugin-cloudflare
    // keeps that measurement standing across Hono upgrades.
    const form = await this.ctx.req.parseBody({ all: true })

    // Verified here as well as by the global CSRF middleware, because *this*
    // form must not depend on that middleware being mounted. An app with
    // `autoSession: false`, or one composing its own middleware chain, can
    // easily not have it — and `csrfField()` below renders an entirely
    // convincing token either way, so the screen would look protected while
    // any site could POST a grant on a signed-in user's behalf. The token is
    // read through the framework's own `verifyCsrfToken`, never a comparison
    // written here: a second implementation of that check is how one of them
    // comes to accept a token the other rejects.
    if (!verifyCsrfToken(this.ctx, single(form[CSRF_FORM_FIELD]))) {
      return this.errorPage(
        419,
        'This consent form has expired',
        'Start the authorization again from the application that sent you here.',
      )
    }

    const provider = this.provider()
    // Re-parsed from the original query rather than trusted from a hidden
    // field holding the request itself: `parseAuthRequest` re-validates the
    // client and its redirect URI, and a form is user input however it got
    // here. The submitted value only decides *which* authorize request this
    // is, and a forged one fails that validation.
    const parsed = await this.parseAuthRequest(
      provider,
      new Request(`${new URL(this.ctx.req.url).origin}/oauth/authorize?${single(form[QUERY_FIELD])}`),
    )
    if (parsed instanceof Response) {
      return parsed
    }

    const offered = this.offeredTools(parsed.scope)
    const offeredScopes = new Set(offered.map((tool) => `tool:${tool.toolName}`))
    // Intersection, not the submission: a checked box for anything the client
    // did not ask for is dropped. `tool:<name>` is the wire form the endpoint's
    // scope grammar parses — the bare tool name grants nothing, silently.
    const granted = many(form[SCOPE_FIELD]).filter((scope) => offeredScopes.has(scope))

    const { redirectTo } = await provider.completeAuthorization({
      request: parsed,
      // The provider's own identifier type is a string; `props.userId` keeps
      // the application's, which is what its policies look up by.
      userId: String(userId),
      scope: granted,
      props: { userId, scopes: granted },
      metadata: { grantedAt: new Date().toISOString() },
    })

    return this.redirect(redirectTo)
  }

  /**
   * Parse an authorize request, answering with a page instead of throwing.
   *
   * `parseAuthRequest` rejects on a query that is malformed, truncated, or
   * tampered with — a missing `client_id`, an unregistered `redirect_uri` — and
   * every one of those is a *routine* arrival at this URL, not an application
   * fault. Left unhandled they surface as a 500 whose body is a stack trace,
   * which is both alarming and useless to the person reading it: the fix is
   * never anything they can do on this page, it is to start again from the
   * client.
   *
   * Deliberately does not echo the provider's message. It is derived from
   * attacker-controllable query parameters, and this page is reached by a
   * browser.
   */
  private async parseAuthRequest(
    provider: OAuthHelpers,
    request: Request,
  ): Promise<AuthRequest | Response> {
    try {
      return await provider.parseAuthRequest(request)
    } catch {
      return this.errorPage(
        400,
        'This authorization link is not valid',
        'Start the authorization again from the application that sent you here.',
      )
    }
  }

  /**
   * The provider helpers, from the Workers env this request captured.
   *
   * `getWorkersEnv()` is first-call-wins, so it hands back the env of
   * whichever request booted the worker — which is safe here because
   * `OAuthProvider` injects `OAUTH_PROVIDER` into `env` on *both* of its
   * paths, before either handler runs (read directly out of the published
   * `oauth-provider.js`: the same `if (!env.OAUTH_PROVIDER) env.OAUTH_PROVIDER
   * = …` guard sits ahead of the default handler and ahead of the API
   * handler). So a worker whose first request was a tool call captures an env
   * carrying the helpers just as one whose first request was this screen does,
   * and the absence below is genuinely diagnostic rather than a race.
   *
   * Wrapped so the failure names the cause a developer actually has: either
   * this is not running on Workers, or the worker was built without
   * `--mcp-oauth` and so was never wrapped in an `OAuthProvider`.
   */
  private provider(): OAuthHelpers {
    let env: WorkerEnvWithProvider
    try {
      env = getWorkersEnv<WorkerEnvWithProvider>()
    } catch (error) {
      throw new Error(
        'The OAuth consent routes require the Cloudflare Workers env. '
        + 'They run only in a worker built with `guren cloudflare:build --mcp-oauth`. '
        + `(${String(error)})`,
      )
    }

    if (!env.OAUTH_PROVIDER) {
      throw new Error(
        'env.OAUTH_PROVIDER is missing. This worker was not wrapped in an OAuthProvider — '
        + 'rebuild with `guren cloudflare:build --mcp-oauth`.',
      )
    }

    return env.OAUTH_PROVIDER
  }

  /**
   * The tools this authorize request may grant: every MCP-exposed tool the
   * requested scopes expand to, in router order.
   */
  private offeredTools(requested: string[]): DerivedAgentTool[] {
    const { tools } = deriveAgentTools(this.make<Application>('app').router.definitions())
    const exposed = tools.filter((tool) => tool.expose.mcp)

    const allowed = new Set(
      expandToolScopes(
        requested,
        exposed.map((tool) => ({ name: tool.toolName, readOnly: tool.annotations.readOnlyHint })),
      ),
    )

    return exposed.filter((tool) => allowed.has(tool.toolName))
  }

  private loginUrl(): string {
    const target = new URL(this.ctx.req.url)
    return `${LOGIN_PATH}?redirectTo=${encodeURIComponent(`${target.pathname}${target.search}`)}`
  }

  private html(body: string, status = 200): Response {
    return this.text(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }

  /** A plain, stack-free page for the arrivals that are nobody's bug. */
  private errorPage(status: number, title: string, advice: string): Response {
    return this.html(
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0 auto; max-width: 32rem; padding: 3rem 1rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; }
  p { opacity: .8; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(advice)}</p>
</body>
</html>
`,
      status,
    )
  }

  private consentScreen(input: {
    client: ClientInfo | null
    clientId: string
    tools: DerivedAgentTool[]
    query: string
  }): string {
    const clientName = escapeHtml(input.client?.clientName ?? input.clientId)

    const body =
      input.tools.length === 0
        ? '<p class="empty">This application requested no tools it can be granted. '
          + 'Nothing here would give it access, so there is nothing to approve.</p>'
        : `<ul class="tools">${input.tools.map(toolRow).join('')}</ul>`

    const actions =
      input.tools.length === 0
        ? ''
        : '<button type="submit">Approve selected</button>'

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize ${clientName}</title>
<style>
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
</style>
</head>
<body>
<h1><strong>${clientName}</strong> is asking to use this application's tools</h1>
<p>Approving lets it act as you, through the tools you select. Uncheck anything you would rather it could not do.</p>
<form method="post" action="/oauth/authorize">
  ${csrfField(this.ctx)}
  <input type="hidden" name="${QUERY_FIELD}" value="${escapeHtml(input.query)}" />
  ${body}
  ${actions}
</form>
</body>
</html>
`
  }
}

function toolRow(tool: DerivedAgentTool): string {
  const name = escapeHtml(tool.toolName)
  const badges = [
    tool.annotations.readOnlyHint ? '<span class="badge">read only</span>' : '',
    tool.approval === 'required' ? '<span class="badge">approval required</span>' : '',
  ].join('')
  const description = tool.description ? `<span class="desc">${escapeHtml(tool.description)}</span>` : ''
  // Read-only tools arrive ticked; anything that can write does not. The
  // default is what most people will accept unread, so it is the framework's
  // fail-closed posture rendered as a checkbox: granting a write has to be a
  // decision somebody made, not one they failed to undo.
  const checked = tool.annotations.readOnlyHint ? ' checked' : ''

  return (
    `<li><label><input type="checkbox" name="${SCOPE_FIELD}" value="tool:${name}"${checked} />`
    + `<span class="name">${name}</span>${badges}</label>${description}</li>`
  )
}

/** One value from a parsed body field that may legally hold several. */
function single(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Every string value of a parsed body field, whether it held one or many. */
function many(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  return []
}

/**
 * Everything rendered here comes from somewhere this application does not
 * control — a dynamically registered client's own name, a route's description
 * — so all of it is escaped. `'` and `"` included: values land inside
 * attributes as well as text.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
