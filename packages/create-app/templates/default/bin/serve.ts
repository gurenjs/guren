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

// The walk past a busy port lives in listen() now, which is also the only
// place that can report which port it ended up on. Set GUREN_STRICT_PORT=1 to
// fail fast instead — what an automated consumer wants when it has to know
// the app under test is the one answering.
await app.listen({ port, hostname })
