import type { WriterOptions } from './utils'
import { scaffoldFile } from './utils'

const MIDDLEWARE_DIR = 'app/Http/Middleware'

function middlewareTemplate(className: string): string {
  return `import { defineMiddleware, type Context } from '@guren/core'

export const ${className} = defineMiddleware(async (ctx: Context, next: () => Promise<void>) => {
  await next()
})
`
}

export async function makeMiddleware(name: string, options: WriterOptions = {}): Promise<string> {
  return scaffoldFile(name, {
    dir: MIDDLEWARE_DIR,
    suffix: 'Middleware',
    template: ({ normalizedName }) => middlewareTemplate(normalizedName),
  }, options)
}
