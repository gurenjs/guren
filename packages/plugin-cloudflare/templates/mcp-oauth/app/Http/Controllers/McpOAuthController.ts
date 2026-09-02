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
 * **The markup lives in `app/View/`, not here.** `McpOAuthConsentPage.tsx` and
 * `McpOAuthErrorPage.tsx` are `hono/jsx` components rendered by
 * `Controller.view()` (RFC 0014) — server-rendered, no hydration, no client
 * bundle, and deliberately not Inertia (see the consent page's own header for
 * why). This file decides *what* to show; those decide how it looks.
 *
 * Escaping comes with the renderer: `hono/jsx` escapes text children and
 * attribute values, so nothing here hand-escapes anything. What it does not do
 * is validate URL schemes — see `Controller.view()`'s contract before adding a
 * user-supplied `href`.
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
  deriveAgentTools,
  expandToolScopes,
  getCsrfToken,
  verifyCsrfToken,
} from '@guren/core'
import type { Application, DerivedAgentTool } from '@guren/core'
// The lean subpath, deliberately not the root entry: the root also exports
// `buildCloudflareOutput`, so importing from it would pull the deploy
// generator and its node builtins into this app's route graph on every boot
// and into the wrangler bundle on every deploy.
import { getWorkersEnv } from '@guren/plugin-cloudflare/env'
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'

import { McpOAuthErrorPage } from '../../View/McpOAuthErrorPage.js'
// `SCOPE_FIELD` and `QUERY_FIELD` are imported from the view rather than
// declared here: the page renders the form, so it owns its field names, and
// this file reads them back. Two declarations would be two spellings of one
// contract, and the failure — a submitted field nothing looks for — is silent.
import {
  McpOAuthConsentPage,
  QUERY_FIELD,
  SCOPE_FIELD,
} from '../../View/McpOAuthConsentPage.js'

/**
 * Where an unauthenticated visitor is sent. The consent decision is only
 * meaningful for a signed-in user — change this to your own login path.
 */
const LOGIN_PATH = '/login'

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

    return this.view(McpOAuthConsentPage, {
      // The client's registered name when it has one; its id otherwise, which
      // is at least something the person can recognize in the client's own UI.
      clientName: client?.clientName ?? parsed.clientId,
      query: new URL(this.ctx.req.url).searchParams.toString(),
      tools: this.offeredTools(parsed.scope),
      csrfToken: getCsrfToken(this.ctx),
    })
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

  /** A plain, stack-free page for the arrivals that are nobody's bug. */
  private errorPage(status: number, title: string, advice: string): Promise<Response> {
    return this.view(McpOAuthErrorPage, { title, advice }, { status })
  }
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
