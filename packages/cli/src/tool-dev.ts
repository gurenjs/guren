/**
 * `guren tool:dev` — run this app's App MCP endpoint locally with a throwaway token, and
 * print the MCP Inspector invocation that connects to it (RFC 0016 §6). The endpoint is
 * the application's own; this command mounts nothing.
 *
 * **The token is ephemeral by construction, not by policy.** It is issued into a
 * `MemoryApiTokenStore` installed over whatever store the app configured, so nothing is
 * written to the real store and "revoking" it is exiting. The override works because
 * `@guren/plugin-mcp` resolves the store per request rather than at boot.
 */
import { consola } from 'consola'
import { createApiToken, MemoryApiTokenStore } from '@guren/core'
import { loadBootedApplication } from './runtime'
import { parseUserId } from './token-issue'

/** Default mount path of `@guren/plugin-mcp`. */
const DEFAULT_MCP_PATH = '/mcp'

/**
 * The user a tool call authenticates as without `--as`. Deliberately an id no real record
 * has, so a call that loads a user fails visibly instead of acting as whoever owns row 1.
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
 * Ask the running app whether the endpoint is really there — by using it: a real
 * `tools/list` carrying the minted token, judged on the JSON-RPC answer. A bearer-less
 * probe cannot settle it either way (a global `requireAuthenticated()` answers 401 with no
 * plugin mounted, and hides the plugin's own 401 when one is). An answer proves the
 * endpoint is mounted, the token authenticates, and the scopes admit the catalogue.
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

  // The transport answers over SSE or plain JSON depending on Accept, so the marker is
  // the JSON-RPC envelope rather than a shape.
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
 * Stop a listener this command started, without letting the stop itself become the
 * reported failure — every caller already has something worse to report.
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
  /** The user id tool calls authenticate as: digits-only becomes a number, else a string. */
  userId: string | number
}

export async function runToolDev(options: ToolDevOptions = {}): Promise<ToolDevSession> {
  // No production use: it installs a token store over the app's own and issues a
  // credential that skips issuance policy. Refusing here means a mistyped deploy script
  // stops at a message instead of listening.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'tool:dev is a development command: it replaces the application\'s token store with an '
        + 'in-memory one for this process. Refusing to run with NODE_ENV=production.',
    )
  }

  const path = options.path ?? DEFAULT_MCP_PATH
  if (!path.startsWith('/')) {
    // Checked before the app is loaded: `--path mcp` concatenates to
    // `http://host:3333mcp`, and there is no reason to start a server to find that out.
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
    // The app's own options, verbatim: replacing the store must change where tokens live
    // and nothing else. A bare `useTokens(store)` drops the app's `provider`, so a token
    // resolves to `{ id }` rather than the real user record — silently.
    app.auth.useTokens(store, app.auth.getApiTokenOptions?.())
  } catch (error) {
    // `useTokens` refuses to shadow a guard something else registered under that name —
    // an app-shaped problem, so it gets an app-shaped message.
    throw new Error(
      'Could not install a throwaway token store: this application already registers a guard '
        + `named "token" that it did not create through useTokens(). Rename that guard, or issue a `
        + `token yourself with \`guren token:issue\`. (${error instanceof Error ? error.message : String(error)})`,
    )
  }

  // The same reader `token:issue` uses: a digits-only id reaches the provider as a
  // number, and `0042` stays the string it is.
  const userId = options.as === undefined ? ANONYMOUS_DEV_USER : parseUserId(options.as)
  const { plainTextToken } = await createApiToken(store, {
    name: 'guren tool:dev',
    userId,
    // Everything the app exposes: the token cannot outlive the process, and a narrower
    // default would show an empty catalogue. `token:issue` is where scoping is a decision.
    abilities: ['tools:*'],
  })

  const port = options.port ?? 3333
  const hostname = options.hostname ?? '127.0.0.1'
  const address = (await app.listen?.({ port, hostname })) as
    | { url?: string; port?: number; hostname?: string }
    | undefined

  // The address the app reports binding, never the requested one: a listener may walk
  // the port forward, and printing the asked-for one sends the Inspector at whatever else
  // is on it. A core too old to report one leaves only the request, so that assumption is
  // stated rather than hidden.
  if (address?.url === undefined && port === 0) {
    // The OS chose the port and the app did not say which; `http://host:0` would send the
    // probe nowhere and then blame the plugin for it.
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
    // `runToolDev` is exported, so a caller catching this must not be left holding a live
    // server whose real tokens are already unusable.
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
