import app, { ready } from '../src/main.js'

try {
  await ready
} catch (error) {
  console.error('Failed to bootstrap application:', error)
  process.exit(1)
}

// `PORT=0` means "any free port", so this tests for a number, not truthiness.
const parsedPort = Number.parseInt(process.env.PORT ?? '', 10)
const port = Number.isInteger(parsedPort) ? parsedPort : 3333
const hostname = process.env.HOST || '0.0.0.0'

// listen() walks past a busy port and is the only place that can report the
// port it ended up on. GUREN_STRICT_PORT=1 fails fast instead — what an
// automated consumer needs to know the app under test is the one answering.
await app.listen({ port, hostname })
