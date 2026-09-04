/**
 * The OAuth consent screen for this application's own agent tools, scaffolded
 * once by `guren cloudflare:build --mcp-oauth` and yours to edit from here.
 * `@cloudflare/workers-oauth-provider` owns every other part of the flow —
 * discovery, client registration, the token endpoint, PKCE, refresh, `props`
 * encryption — and hands back the one decision it cannot make: who is signed in
 * and what they agreed to. The markup is in `app/View/`, rendered by
 * `Controller.view()` (RFC 0014).
 *
 * The tools are derived live from the router, never read from
 * `.guren/agents.gen.ts`: a build artifact can be stale, and a screen omitting a
 * tool the dispatcher would allow is the one bug it cannot have. The grant is an
 * intersection of what the client asked for, because the provider does not
 * enforce that and a form is user input. Off Workers `getWorkersEnv` throws at
 * request time rather than import time, so `guren codegen`, `guren check` and
 * your tests can still import this file.
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
// `buildCloudflareOutput`, which would pull the deploy generator and its node
// builtins into this app's route graph and into the wrangler bundle.
import { getWorkersEnv } from '@guren/plugin-cloudflare/env'
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'

import { McpOAuthErrorPage } from '../../View/McpOAuthErrorPage.js'
// Imported from the view rather than declared here: the page renders the form,
// so it owns its field names. Two spellings of one contract fail silently — a
// submitted field nothing looks for.
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

    // `all: true` turns the repeated `scope` checkboxes into an array instead of
    // the last one winning. The CSRF middleware already called `parseBody()`
    // with no options, but Hono keys its body cache on those options rather than
    // on the request alone, so this second call still returns the array —
    // measured, and kept standing by @guren/plugin-cloudflare's
    // `tests/hono-parse-body.test.ts` across Hono upgrades.
    const form = await this.ctx.req.parseBody({ all: true })

    // Verified here as well as by the global CSRF middleware, because this form
    // must not depend on that middleware being mounted: an app with
    // `autoSession: false` or its own chain may not have it, and the rendered
    // token looks convincing either way, so the screen would look protected
    // while any site could POST a grant. Through the framework's own
    // `verifyCsrfToken`, never a comparison written here.
    if (!verifyCsrfToken(this.ctx, single(form[CSRF_FORM_FIELD]))) {
      return this.errorPage(
        419,
        'This consent form has expired',
        'Start the authorization again from the application that sent you here.',
      )
    }

    const provider = this.provider()
    // Re-parsed from the original query rather than trusted from a hidden field
    // holding the request itself: `parseAuthRequest` re-validates the client and
    // its redirect URI, so a forged submission fails that validation.
    const parsed = await this.parseAuthRequest(
      provider,
      new Request(`${new URL(this.ctx.req.url).origin}/oauth/authorize?${single(form[QUERY_FIELD])}`),
    )
    if (parsed instanceof Response) {
      return parsed
    }

    const offered = this.offeredTools(parsed.scope)
    const offeredScopes = new Set(offered.map((tool) => `tool:${tool.toolName}`))
    // Intersection, not the submission: a box checked for anything the client
    // did not ask for is dropped. `tool:<name>` is the wire form the scope
    // grammar parses — a bare tool name grants nothing, silently.
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
   * Parse an authorize request, answering with a page instead of throwing: a
   * malformed, truncated or tampered query is a routine arrival at this URL, not
   * an application fault, and unhandled would surface as a 500 with a stack
   * trace. The provider's own message is deliberately not echoed — it derives
   * from attacker-controllable query parameters, and a browser reads this page.
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
   * `getWorkersEnv()` is first-call-wins, which is safe here because
   * `OAuthProvider` injects `OAUTH_PROVIDER` into `env` on *both* of its paths
   * before either handler runs (read out of the published `oauth-provider.js`),
   * so the absence below is diagnostic rather than a race. Wrapped so the
   * failure names the cause: not on Workers, or built without `--mcp-oauth`.
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

  /** Every MCP-exposed tool the requested scopes expand to, in router order. */
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
