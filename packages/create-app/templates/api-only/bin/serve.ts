import app, { ready } from '../src/main.js'

try {
  await ready
} catch (error) {
  console.error('Failed to bootstrap application:', error)
  process.exit(1)
}

// HSTS, the Secure session cookie, hidden error details and the APP_URL host
// allowlist all key on NODE_ENV=production, which `bun bin/serve.ts` alone never sets.
function deployedHost(appUrl: string | undefined): string | undefined {
  if (!appUrl) return undefined
  let host: string
  try {
    host = new URL(appUrl).hostname
  } catch {
    return undefined
  }
  const loopback = host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.')
    || host === '[::1]' || host === '0.0.0.0'
  return loopback ? undefined : host
}

const nodeEnv = process.env.NODE_ENV
const appHost = deployedHost(process.env.APP_URL)
if (appHost && nodeEnv !== 'production' && nodeEnv !== 'test') {
  console.warn(
    `APP_URL points at ${appHost} but NODE_ENV is ${nodeEnv ? `"${nodeEnv}"` : 'unset'}, so the production `
    + 'security defaults are off. Start a deployed app with `bun run start` or set NODE_ENV=production.',
  )
}

// `PORT=0` means "any free port", so this tests for a number, not truthiness.
const parsedPort = Number.parseInt(process.env.PORT ?? '', 10)
const port = Number.isInteger(parsedPort) ? parsedPort : 3333
const hostname = process.env.HOST || '0.0.0.0'

// The walk past a busy port lives in listen() now, which is also the only
// place that can report which port it ended up on. Set GUREN_STRICT_PORT=1 to
// fail fast instead — what an automated consumer wants when it has to know
// the app under test is the one answering.
await app.listen({ port, hostname })
