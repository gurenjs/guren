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
import { pathToFileURL } from 'node:url'
import { createApiToken, MemoryApiTokenStore } from '@guren/core'
import {
  bootstrapApplication,
  ensureApplicationBooted,
  resolveMainEntry,
  type MaybeApplication,
} from './runtime'

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
 * Ask the running app whether the endpoint is really there.
 *
 * Positive evidence rather than assumption: the answer has to be *the
 * plugin's* refusal, not merely a refusal. A mounted endpoint replies 401
 * with its own `{ error: 'unauthorized' }` body once a store is configured,
 * which one was a moment ago. The status alone is not enough — an app that
 * never registered the plugin but mounts `requireAuthenticated()` globally
 * answers 401 on this path too (measured), and reading that as "live" would
 * print a token that cannot work and send the developer looking at their
 * client.
 *
 * Guessing from the app's dependencies would be worse still: it reports an
 * endpoint for an app that installed the package and never registered the
 * plugin.
 */
async function probeEndpoint(url: string): Promise<EndpointProbe> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: '{}',
    })
  } catch (error) {
    return { mounted: false, status: 0, detail: error instanceof Error ? error.message : String(error) }
  }

  if (response.status !== 401) {
    return { mounted: false, status: response.status }
  }

  const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined
  if (body?.error === 'unauthorized') {
    return { mounted: true }
  }

  return {
    mounted: false,
    status: 401,
    detail: 'something else on this path refused the request — a global authentication middleware, not the MCP endpoint',
  }
}

/** What the command established, for a caller that needs it rather than the printout. */
export interface ToolDevSession {
  /** Absolute URL of the live App MCP endpoint. */
  endpoint: string
  /** The throwaway bearer, which exists only for this process's lifetime. */
  token: string
  /** The user id tool calls authenticate as. */
  userId: string
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

  const entry = await resolveMainEntry(options.appRoot)

  let moduleExports: Record<string, unknown>
  try {
    moduleExports = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `Failed to import application entry (${entry}): ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const app: MaybeApplication = await bootstrapApplication(moduleExports)
  await ensureApplicationBooted(app, moduleExports, { rethrow: true })

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
  app.auth.useTokens(store)

  const userId = options.as ?? ANONYMOUS_DEV_USER
  const { plainTextToken } = await createApiToken(store, {
    name: 'guren tool:dev',
    userId,
    // Everything the app exposes: this token cannot outlive the process, and
    // a narrower default would make the first thing a developer sees an empty
    // catalogue. `token:issue` is where scoping is a decision.
    abilities: ['tools:*'],
  })

  const address = (await app.listen?.({
    port: options.port ?? 3333,
    hostname: options.hostname ?? '127.0.0.1',
  })) as { url?: string; port?: number; hostname?: string } | undefined

  // The address the app reports binding, never the one that was requested:
  // a listener may walk the port forward, and printing the asked-for one
  // sends the Inspector at whatever else is on it.
  //
  // A `@guren/core` old enough not to report one leaves nothing better than
  // the request to go on, so the assumption is stated rather than hidden —
  // the probe below then fails against the wrong address, and the developer
  // needs to know which of the two things went wrong.
  if (address?.url === undefined) {
    consola.warn(
      'This application did not report the address it bound, so the URL below assumes the '
        + 'requested one. If the port was taken, the listener may have moved.',
    )
  }
  const base = address?.url ?? `http://${options.hostname ?? '127.0.0.1'}:${options.port ?? 3333}`
  const path = options.path ?? DEFAULT_MCP_PATH
  const endpoint = `${base.replace(/\/$/u, '')}${path}`

  const probe = await probeEndpoint(endpoint)
  if (!probe.mounted) {
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

  return { endpoint, token: plainTextToken, userId: String(userId) }
}
