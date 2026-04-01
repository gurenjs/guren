/**
 * Vercel Serverless Function entrypoint.
 *
 * This keeps the web app aligned with the reusable plugin implementation.
 */
import app from './app.js'
import { createVercelHandler } from '@guren/plugin-vercel'

export default await createVercelHandler(app)
