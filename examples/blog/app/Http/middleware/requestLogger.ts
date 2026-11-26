import { defineMiddleware } from '@guren/core'
import { printable } from '../../Support/printable.js'

const requestLogger = defineMiddleware(async (ctx, next) => {
  const started = performance.now()
  await next()
  const elapsed = Math.round(performance.now() - started)
  console.log(`[blog] ${ctx.req.method} ${printable(ctx.req.path)} -> ${ctx.res.status} (${elapsed}ms)`)
})

export default requestLogger
