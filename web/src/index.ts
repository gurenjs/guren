/**
 * Vercel Serverless Function entrypoint.
 *
 * Inertia env vars are injected via .vc-config.json environment
 * by the vercel-build script. This file just boots the app.
 */
import app from './app.js'

await app.boot()

export default {
  fetch: (request: Request) => app.fetch(request),
}
