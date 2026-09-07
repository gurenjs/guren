import app, { ready } from '../src/main'

try {
  await ready
} catch (error) {
  console.error('Failed to bootstrap application:', error)
  process.exit(1)
}

// `PORT=0` means "any free port", so this tests for a number, not truthiness.
const parsedPort = Number.parseInt(process.env.PORT ?? '', 10)
const port = Number.isInteger(parsedPort) ? parsedPort : 3336
const hostname = process.env.HOST || '127.0.0.1'

// `portFallback: false`: a busy port is a misconfiguration worth reporting, not
// something to paper over by serving on a port nobody was told about.
const address = await app.listen({ port, hostname, vite: false, portFallback: false })

console.log(`Triager demo running at ${address.url}`)
console.log('Agents need workerd: `bun run cloudflare:build && bunx wrangler dev --local`.')
