import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const MIDDLEWARE_DIR = 'app/Http/Middleware'

function middlewareTemplate(className: string): string {
  return `import { defineMiddleware, type Context } from '@guren/core'

/**
 * ${className} middleware.
 */
export const ${className} = defineMiddleware(async (ctx: Context, next: () => Promise<void>) => {
  // Before request handling
  // console.log('Request:', ctx.req.method, ctx.req.url)

  await next()

  // After request handling
  // console.log('Response:', ctx.res.status)
})

export default ${className}
`
}

export async function makeMiddleware(name: string, options: WriterOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: MIDDLEWARE_DIR,
    suffix: 'Middleware',
    template: ({ normalizedName }) => middlewareTemplate(normalizedName),
  }, options)
}
