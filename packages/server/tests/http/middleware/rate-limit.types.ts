import { createRateLimitMiddleware } from '../../../src/http/middleware/rate-limit'

/**
 * A type-only fixture: none of these middlewares is ever mounted, and `bun run
 * typecheck` is the assertion. `statusCode` used to be `number`, and the
 * default handler cast it to the literal `429` before calling `ctx.json()`, so
 * a status Hono cannot send a body with type-checked here and failed at
 * runtime instead.
 */

createRateLimitMiddleware({ limit: 1, statusCode: 429 })
createRateLimitMiddleware({ limit: 1, statusCode: 503 })
createRateLimitMiddleware({ limit: 1 })

// A body cannot be sent with these, which is what the limiter's default
// handler does with the status it is given.
// @ts-expect-error 204 carries no content
createRateLimitMiddleware({ limit: 1, statusCode: 204 })
// @ts-expect-error 304 carries no content
createRateLimitMiddleware({ limit: 1, statusCode: 304 })

// The narrow case the narrowing costs: a status that reaches the option as a
// plain `number` — read from config, say — now needs one at the call site.
const fromConfig: number = 429
// @ts-expect-error a plain number is not a status Hono can be handed
createRateLimitMiddleware({ limit: 1, statusCode: fromConfig })
createRateLimitMiddleware({ limit: 1, statusCode: fromConfig as 429 })
