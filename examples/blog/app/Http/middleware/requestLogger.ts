import { defineMiddleware } from '@guren/core'

const requestLogger = defineMiddleware(async (ctx, next) => {
  const started = performance.now()
  await next()
  const elapsed = Math.round(performance.now() - started)
  console.log(`[blog] ${ctx.req.method} ${ctx.req.path} -> ${ctx.res.status} (${elapsed}ms)`)
})

export default requestLogger
