import app, { ready } from '../src/main.js'

try {
  await ready
} catch (error) {
  console.error('Failed to bootstrap application:', error)
  process.exit(1)
}

const requestedPort = Number.parseInt(process.env.PORT ?? '', 10) || 3333
const hostname = process.env.HOST ?? '0.0.0.0'
const isDevelopment = process.env.NODE_ENV !== 'production'

for (let offset = 0; offset < 20; offset += 1) {
  const port = requestedPort + offset

  try {
    await app.listen({ port, hostname })
    break
  } catch (error) {
    if (!isDevelopment || !isAddressInUse(error) || offset === 19) {
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
