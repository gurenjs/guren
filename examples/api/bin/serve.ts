import app, { ready } from '../src/main.js'

try {
  await ready
} catch (error) {
  console.error('Failed to bootstrap application:', error)
  process.exit(1)
}

const port = Number.parseInt(process.env.PORT ?? '', 10) || 3334
const hostname = process.env.HOST ?? '0.0.0.0'

await app.listen({ port, hostname, vite: false })

console.log(`API server running at http://${hostname}:${port}`)
