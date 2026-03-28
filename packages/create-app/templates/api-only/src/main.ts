import app from './app.js'

export async function bootstrap() {
  await app.boot()
  return app
}

export const ready = bootstrap()

export default app
