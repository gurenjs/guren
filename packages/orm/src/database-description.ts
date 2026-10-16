/**
 * Where a factory's database lives, judged without connecting (RFC 0033 §3): what lets
 * `guren browser:serve` refuse to boot an app against a database it cannot show is local.
 * Anything not positively local is `remote` or `unknown`, never `local`. The connection
 * string itself is never part of the result, since it can carry a password.
 */

import type { ConnectionContext, ConnectionResolver } from './connection-context'

export interface DatabaseDescription {
  dialect: 'postgres' | 'mysql' | 'sqlite' | 'd1'
  location: 'local' | 'remote' | 'unknown'
  reason?: string
}

// Must equal AGENT_REDACTED in @guren/server's agent/redact.ts, which the ORM cannot import:
// report-mode env parsing writes it for a required key that is unset or invalid.
const REDACTED = '[REDACTED]'

/** A resolver's value for `context`, without touching the factory's kept context or its staleness record. */
export function resolveFor(value: ConnectionResolver | undefined, context: ConnectionContext | undefined): string | undefined {
  return typeof value === 'function' ? value(context) : value
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname)
}

/** A server database's location from its connection string and the client options laid over it. */
export function describeServerDatabase(
  dialect: 'postgres' | 'mysql',
  connectionString: string | undefined,
  clientOptions: object | undefined,
): DatabaseDescription {
  if (connectionString === undefined) return { dialect, location: 'unknown', reason: 'No connection string resolves.' }
  if (connectionString.includes(REDACTED)) return { dialect, location: 'unknown', reason: 'The connection string is the placeholder the env reader writes for a missing or invalid value.' }
  const override = ['host', 'hostname', 'path', 'socketPath'].find((key) => clientOptions !== undefined && key in clientOptions)
  if (override) return { dialect, location: 'unknown', reason: `The client options set \`${override}\`, which the connection string does not show.` }
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    return { dialect, location: 'unknown', reason: 'The connection string is not a URL.' }
  }
  if (url.searchParams.has('host') || url.searchParams.has('socket')) return { dialect, location: 'unknown', reason: 'The connection string names a socket.' }
  if (url.hostname === '') return { dialect, location: 'unknown', reason: 'The connection string names no host.' }
  return isLoopbackHost(url.hostname)
    ? { dialect, location: 'local' }
    : { dialect, location: 'remote', reason: `The database host ${url.hostname} is not a loopback address.` }
}

export function describeSqliteDatabase(filename: () => string | undefined): DatabaseDescription {
  let value: string | undefined
  try {
    value = filename()
  } catch (error) {
    return { dialect: 'sqlite', location: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
  if (value === undefined) return { dialect: 'sqlite', location: 'unknown', reason: 'The database file does not resolve.' }
  if (value.includes(REDACTED)) return { dialect: 'sqlite', location: 'unknown', reason: 'The database file is the placeholder the env reader writes for a missing or invalid value.' }
  return { dialect: 'sqlite', location: 'local' }
}
