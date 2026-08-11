import app, { ready } from '../src/main.js'

try {
  await ready
} catch (error) {
  console.error('Failed to bootstrap application:', error)
  process.exit(1)
}

// `PORT=0` means "any free port", so this tests for a number, not truthiness.
const parsedPort = Number.parseInt(process.env.PORT ?? '', 10)
const port = Number.isInteger(parsedPort) ? parsedPort : 3334
const hostname = process.env.HOST ?? '0.0.0.0'

// `portFallback: false` keeps this entrypoint's original fail-fast behaviour.
// It never walked, and it must not start: the OpenAPI document it serves
// advertises `http://localhost:3334` as the server, so binding 3335 instead
// would hand clients a URL that answers nothing.
const address = await app.listen({ port, hostname, vite: false, portFallback: false })

// Printed from the address listen() returned, not from the port that was
// requested — with a port walk or PORT=0 those are different numbers.
console.log(`API server running at ${address.url}`)
console.log(`OpenAPI JSON available at ${address.url}/api/openapi.json`)
console.log(`API docs available at ${address.url}/api/docs`)
