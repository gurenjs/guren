/**
 * Where a factory's database lives, judged without connecting (RFC 0033 §3): what lets
 * `guren browser:serve` refuse to boot an app against a database it cannot show is local.
 * Anything not positively local is `remote` or `unknown`, never `local`. The connection
 * string itself is never part of the result, since it can carry a password.
 */

export interface DatabaseDescription {
  dialect: 'postgres' | 'mysql' | 'sqlite' | 'd1'
  location: 'local' | 'remote' | 'unknown'
  reason?: string
}

// Must equal AGENT_REDACTED in @guren/server's agent/redact.ts, which the ORM cannot import:
// report-mode env parsing writes it for a required key that is unset or invalid.
// packages/core/tests/config.test.ts pins the two together.
const REDACTED = '[REDACTED]'

/**
 * Client option and connection-string query keys that cannot move the endpoint off the URL's
 * host. Anything else (`host`, mysql2's `uri`, a `stream` or `socket` factory, a key a later
 * driver adds) reads as `unknown`: an allowlist, so a new option fails closed.
 */
const ENDPOINT_NEUTRAL_KEYS: Record<'postgres' | 'mysql', ReadonlySet<string>> = {
  postgres: new Set([
    'max', 'idle_timeout', 'connect_timeout', 'max_lifetime', 'backoff', 'keep_alive', 'ssl', 'sslmode', 'prepare',
    'types', 'transform', 'onnotice', 'onparameter', 'onclose', 'debug', 'fetch_types', 'connection', 'publications',
    'user', 'username', 'pass', 'password', 'database', 'db', 'port', 'application_name', 'options', 'search_path',
  ]),
  mysql: new Set([
    'waitForConnections', 'connectionLimit', 'maxIdle', 'idleTimeout', 'queueLimit', 'enableKeepAlive',
    'keepAliveInitialDelay', 'ssl', 'timezone', 'charset', 'typeCast', 'connectTimeout', 'user', 'password',
    'database', 'port', 'dateStrings', 'decimalNumbers', 'supportBigNumbers', 'bigNumberStrings', 'jsonStrings',
    'multipleStatements', 'namedPlaceholders', 'rowsAsArray', 'nestTables', 'compress', 'debug', 'trace',
  ]),
}

/** The loopback rule of `isLoopbackOrigin()` in @guren/server's loopback-guard.ts, over a WHATWG hostname. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/u.test(hostname)
}

/** A server database's location from its connection string and the client options laid over it. */
export function describeServerDatabase(
  dialect: 'postgres' | 'mysql',
  connectionString: string | undefined,
  clientOptions: object | undefined,
): DatabaseDescription {
  if (connectionString === undefined) return { dialect, location: 'unknown', reason: 'No connection string resolves.' }
  if (connectionString.includes(REDACTED)) return { dialect, location: 'unknown', reason: 'The connection string is the placeholder the env reader writes for a missing or invalid value.' }
  const neutral = ENDPOINT_NEUTRAL_KEYS[dialect]
  const option = Object.keys(clientOptions ?? {}).find((key) => !neutral.has(key))
  if (option) return { dialect, location: 'unknown', reason: `The client options set \`${option}\`, which may choose the endpoint.` }
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    return { dialect, location: 'unknown', reason: 'The connection string is not a URL.' }
  }
  // mysql2 applies every query key as a client option; postgres.js reads host only from the authority.
  const query = [...url.searchParams.keys()].find((key) => dialect === 'mysql' ? !neutral.has(key) : key === 'host' || key === 'hostaddr')
  if (query) return { dialect, location: 'unknown', reason: `The connection string's query sets \`${query}\`, which may choose the endpoint.` }
  const hostname = url.hostname.toLowerCase()
  if (hostname === '') return { dialect, location: 'unknown', reason: 'The connection string names no host.' }
  return isLoopbackHost(hostname)
    ? { dialect, location: 'local' }
    : { dialect, location: 'remote', reason: `The database host ${hostname} is not a loopback address.` }
}

export function describeSqliteDatabase(filename: () => string): DatabaseDescription {
  let value: string
  try {
    value = filename()
  } catch {
    // Not the error's message: the driver's own names the value, which may be a URI with a password.
    return { dialect: 'sqlite', location: 'unknown', reason: 'The database setting is not a file path the SQLite driver accepts, such as a connection URI.' }
  }
  if (value.includes(REDACTED)) return { dialect: 'sqlite', location: 'unknown', reason: 'The database file is the placeholder the env reader writes for a missing or invalid value.' }
  return { dialect: 'sqlite', location: 'local' }
}
