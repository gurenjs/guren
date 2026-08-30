/**
 * `guren tool:dev` — run this app's App MCP endpoint locally with a throwaway
 * token, and print the MCP Inspector invocation that connects to it
 * (RFC 0016 §6).
 *
 * The endpoint itself is the application's own: this command mounts nothing
 * and inspects nothing. What it adds is the one thing that makes the real
 * endpoint awkward to try — a bearer token — without asking anyone to mint a
 * lasting credential to look at a catalogue.
 *
 * **The token is ephemeral by construction, not by policy.** It is issued into
 * a `MemoryApiTokenStore` this process creates, which the command then
 * installs over whatever store the app configured. Nothing is written to the
 * app's real store, so nothing survives the process; and because the token
 * exists only in this process's memory, "revoking" it is exiting. The
 * override is possible at all because `@guren/plugin-mcp` resolves the store
 * per request rather than at boot — and it is *safe* because installing a
 * store is a local, in-process act by a command that already had the app's
 * code in hand.
 */
import { consola } from 'consola'
import { createApiToken, MemoryApiTokenStore } from '@guren/core'
import { loadBootedApplication } from './runtime'
import { parseUserId } from './token-issue'

/** Default mount path of `@guren/plugin-mcp`. */
const DEFAULT_MCP_PATH = '/mcp'

/**
 * The user a tool call authenticates as when `--as` is not given.
 *
 * Deliberately an id no real record has, rather than a plausible `1`: a
 * catalogue listing needs no user at all, and a *call* that loads one should
 * fail visibly ("pass --as") instead of quietly acting as whoever happens to
 * own row 1 in the developer's database.
 */
const ANONYMOUS_DEV_USER = 'tool-dev'

export interface ToolDevOptions {
  appRoot?: string
  /** Endpoint path, when the app mounted the plugin somewhere other than /mcp. */
  path?: string
  /** User id tool calls authenticate as. */
  as?: string
  port?: number
  hostname?: string
}

/** What the probe learned about the endpoint, before anything is printed. */
type EndpointProbe =
  | { mounted: true }
  | { mounted: false; status: number; detail?: string }

/**
 * Ask the running app whether the endpoint is really there — by using it.
 *
 * The probe is a real `tools/list` carrying the token this command just
 * minted, and the evidence is a JSON-RPC answer. Nothing weaker survives
 * contact with real apps in both directions:
 *
 * - A bearer-less probe reading any 401 as "mounted" is a false positive: an
 *   app that never registered the plugin but mounts `requireAuthenticated()`
 *   globally answers 401 on this path too.
 * - Reading only *the plugin's own* 401 fixes that and introduces the
 *   opposite error. With the same global middleware in front of a genuinely
 *   mounted endpoint, the bearer-less probe never reaches the plugin, so a
 *   working setup is reported as missing. Both measured.
 *
 * Using the credential settles both, and proves more than it was asked to:
 * an answer here means the endpoint is mounted, the token authenticates, and
 * the scopes admit the catalogue — which is exactly what the printed
 * invocation promises.
 */
async function probeEndpoint(url: string, token: string): Promise<EndpointProbe> {
  let response: Response
  let body: string
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    body = await response.text()
  } catch (error) {
    return { mounted: false, status: 0, detail: error instanceof Error ? error.message : String(error) }
  }

  // The transport answers over SSE or plain JSON depending on what the client
  // accepts, so the marker is the JSON-RPC envelope rather than a shape.
  if (response.ok && body.includes('"jsonrpc"')) {
    return { mounted: true }
  }

  return {
    mounted: false,
    status: response.status,
    detail:
      response.status === 401 || response.status === 403
        ? 'something on this path refused the token — most likely an authentication middleware in front of the endpoint'
        : undefined,
  }
}

/**
 * Stop a listener this command started, without letting the stop itself
 * become the reported failure.
 *
 * Reached only on the paths that already have something worse to report: the
 * caller is about to be told why the endpoint could not be used, and a
 * secondary error about shutting down would bury it.
 */
async function stopQuietly(app: { stop?: (closeConnections?: boolean) => void | Promise<void> }): Promise<void> {
  try {
    await app.stop?.(true)
  } catch {
    // Nothing to add: the throw that follows is the one that matters.
  }
}

/** What the command established, for a caller that needs it rather than the printout. */
export interface ToolDevSession {
  /** Absolute URL of the live App MCP endpoint. */
  endpoint: string
  /** The throwaway bearer, which exists only for this process's lifetime. */
  token: string
  /**
   * The user id tool calls authenticate as, in the form it was stored: a
   * digits-only `--as` becomes the number a serial key is, everything else
   * stays a string.
   */
  userId: string | number
}

export async function runToolDev(options: ToolDevOptions = {}): Promise<ToolDevSession> {
  // The command has no production use: it installs a token store over the
  // app's own and issues a credential that skips issuance policy entirely.
  // Nothing downstream depends on this check — the store lives in this
  // process either way — but refusing here means a mistyped deploy script
  // stops at a message instead of listening.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'tool:dev is a development command: it replaces the application\'s token store with an '
        + 'in-memory one for this process. Refusing to run with NODE_ENV=production.',
    )
  }

  const path = options.path ?? DEFAULT_MCP_PATH
  if (!path.startsWith('/')) {
    // Checked before the app is loaded, let alone bound: concatenated as
    // given, `--path mcp` yields `http://host:3333mcp`, an invalid URL whose
    // only symptom is whatever `fetch` says about it — and there is no reason
    // to have started a server to find that out.
    throw new Error(`Invalid --path value "${path}": an endpoint path must start with "/".`)
  }

  const app = await loadBootedApplication(options.appRoot)

  if (typeof app.auth?.useTokens !== 'function') {
    throw new Error(
      'This application\'s auth manager cannot accept a token store, so tool:dev has no way to '
        + 'issue a throwaway credential. Upgrade @guren/core, or run the app yourself and issue a '
        + 'token with `guren token:issue`.',
    )
  }

  // Installed *after* boot on purpose: an app that configures its own store
  // does so during boot, and this must be the store that answers afterwards.
  const store = new MemoryApiTokenStore()
  try {
    // The app's own options, verbatim: replacing the store must change where
    // tokens live and nothing else. A bare `useTokens(store)` drops the app's
    // `provider`, so a token resolves to a bare `{ id }` instead of the real
    // user record — `--as 42` would then authenticate as something no policy
    // reading a user field can recognise, silently.
    app.auth.useTokens(store, app.auth.getApiTokenOptions?.())
  } catch (error) {
    // `useTokens` refuses to shadow a guard registered under the same name by
    // something else. That is an app-shaped problem, so it gets an
    // app-shaped message rather than the manager's internal one.
    throw new Error(
      'Could not install a throwaway token store: this application already registers a guard '
        + `named "token" that it did not create through useTokens(). Rename that guard, or issue a `
        + `token yourself with \`guren token:issue\`. (${error instanceof Error ? error.message : String(error)})`,
    )
  }

  // Through the same reader `token:issue` uses, so a digits-only id reaches
  // the provider as the number a serial key is — and `0042` stays the string
  // it is.
  const userId = options.as === undefined ? ANONYMOUS_DEV_USER : parseUserId(options.as)
  const { plainTextToken } = await createApiToken(store, {
    name: 'guren tool:dev',
    userId,
    // Everything the app exposes: this token cannot outlive the process, and
    // a narrower default would make the first thing a developer sees an empty
    // catalogue. `token:issue` is where scoping is a decision.
    abilities: ['tools:*'],
  })

  const port = options.port ?? 3333
  const hostname = options.hostname ?? '127.0.0.1'
  const address = (await app.listen?.({ port, hostname })) as
    | { url?: string; port?: number; hostname?: string }
    | undefined

  // The address the app reports binding, never the one that was requested:
  // a listener may walk the port forward, and printing the asked-for one
  // sends the Inspector at whatever else is on it.
  //
  // A `@guren/core` old enough not to report one leaves nothing better than
  // the request to go on, so the assumption is stated rather than hidden —
  // the probe below then fails against the wrong address, and the developer
  // needs to know which of the two things went wrong.
  if (address?.url === undefined && port === 0) {
    // Nothing to fall back to: the OS chose the port and this app did not say
    // which. Constructing `http://host:0` would send the probe somewhere that
    // cannot answer and then blame the plugin for it.
    await stopQuietly(app)
    throw new Error(
      'This application did not report the address it bound, so --port 0 leaves no way to know '
        + 'which port it chose. Pass an explicit --port, or upgrade @guren/core.',
    )
  }
  if (address?.url === undefined) {
    consola.warn(
      'This application did not report the address it bound, so the URL below assumes the '
        + 'requested one. If the port was taken, the listener may have moved.',
    )
  }
  // Bracketed for IPv6: `http://::1:3333` is not a URL.
  const authority = hostname.includes(':') ? `[${hostname}]` : hostname
  const base = address?.url ?? `http://${authority}:${port}`
  const endpoint = `${base.replace(/\/$/u, '')}${path}`

  const probe = await probeEndpoint(endpoint, plainTextToken)
  if (!probe.mounted) {
    // The listener is already up and the app's token store already replaced.
    // `runToolDev` is exported, so a caller that catches this must not be left
    // holding a live server whose real tokens no longer work.
    await stopQuietly(app)
    const observed = probe.status === 0 ? 'the request failed' : `HTTP ${probe.status}`
    throw new Error(
      `No App MCP endpoint answered at ${endpoint} (${observed}`
        + `${probe.detail ? `: ${probe.detail}` : ''}). `
        + 'Install and register the plugin — `guren plugin @guren/plugin-mcp`, then add '
        + '`mcpPlugin()` to createApp({ providers }) — or pass --path if it is mounted elsewhere.',
    )
  }

  consola.success(`App MCP endpoint is live at ${endpoint}`)
  consola.log('')
  consola.log('Connect the MCP Inspector:')
  consola.log('')
  consola.log(`  npx @modelcontextprotocol/inspector --cli ${endpoint} \\`)
  consola.log(`    --transport http --header "Authorization: Bearer ${plainTextToken}"`)
  consola.log('')
  consola.log('Or paste this into a client that takes a bearer token:')
  consola.log(`  URL:   ${endpoint}`)
  consola.log(`  Token: ${plainTextToken}`)
  consola.log('')
  consola.info(
    `The token grants tools:* and exists only in this process — stopping the command revokes it.`,
  )
  if (options.as === undefined) {
    consola.info(
      `Tool calls authenticate as "${ANONYMOUS_DEV_USER}", which matches no real record: listing `
        + 'tools works, but a call whose policy loads a user will fail. Pass --as <id> to act as one.',
    )
  } else {
    consola.info(`Tool calls authenticate as user ${userId}.`)
  }

  return { endpoint, token: plainTextToken, userId }
}
