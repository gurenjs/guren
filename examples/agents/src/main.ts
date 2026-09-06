import app from './app'

export async function bootstrap() {
  await app.boot()
  return app
}

export const ready = bootstrap()
export default app
