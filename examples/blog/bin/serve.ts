import app, { ready } from '../src/main.js'

try {
  await ready
} catch (error) {
  console.error('Failed to bootstrap application:', error)
  process.exit(1)
}

const port = Number.parseInt(process.env.PORT ?? '', 10) || 3333
const hostname = process.env.HOST ?? '0.0.0.0'

app.listen({ port, hostname })
console.log(`Guren blog listening on http://${hostname}:${port}`)
