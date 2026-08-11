import app, { ready } from '../src/main.js'

try {
  await ready
} catch (error) {
  console.error('Failed to bootstrap application:', error)
  process.exit(1)
}

// `PORT=0` means "any free port", so this tests for a number, not truthiness.
const parsedPort = Number.parseInt(process.env.PORT ?? '', 10)
const requestedPort = Number.isInteger(parsedPort) ? parsedPort : 3333
const hostname = process.env.HOST ?? '0.0.0.0'

// In development a busy port moves to the next one. Set GUREN_STRICT_PORT=1 to
// bind the requested port or fail — see the deployment guide.
const isDevelopment = process.env.NODE_ENV !== 'production'
const canWalkPorts =
  isDevelopment && requestedPort !== 0 && process.env.GUREN_STRICT_PORT !== '1'
const attempts = canWalkPorts ? 20 : 1

// This file owns the retry, so the framework must not retry underneath it —
// newer framework versions walk inside listen() themselves, and the two loops
// would nest into a much wider search reported against the wrong ports.
process.env.GUREN_STRICT_PORT = '1'

for (let offset = 0; offset < attempts; offset += 1) {
  const port = requestedPort + offset

  try {
    await app.listen({ port, hostname })
    break
  } catch (error) {
    if (!isAddressInUse(error) || offset === attempts - 1) {
      throw error
    }

    console.warn(`Port ${port} is in use, trying ${port + 1}...`)
  }
}

function isAddressInUse(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EADDRINUSE',
  )
}
