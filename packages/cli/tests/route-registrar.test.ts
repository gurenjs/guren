import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { addRouteRegistrarCall, findRouteRegistrar } from '../src/route-registrar'
import {
  BLOG_ROUTES_FIXTURE,
  DEFAULT_ROUTES_FIXTURE,
  REGISTRAR_LESS_ROUTES_FIXTURE,
  createTempWorkspace,
  type TempWorkspace,
} from './helpers'

/** The body text the returned offsets delimit, for asserting *which* function was picked. */
function body(source: string): string | null {
  const registrar = findRouteRegistrar(source)
  return registrar === null ? null : source.slice(registrar.bodyStart, registrar.bodyEnd)
}

describe('findRouteRegistrar', () => {
  it('reads the parameter name off the default template', () => {
    expect(findRouteRegistrar(DEFAULT_ROUTES_FIXTURE)?.parameterName).toBe('router')
  })

  // The blog template rebinds its parameter to `router` inside the body, so a
  // matcher keyed on the literal name `router` saw no registrar here at all.
  it('reads a parameter named anything else', () => {
    expect(findRouteRegistrar(BLOG_ROUTES_FIXTURE)?.parameterName).toBe('baseRouter')
  })

  it('reads a multi-line signature with a trailing comma', () => {
    const source = `export function registerWebRoutes(
  appRouter: Router<'auth' | 'guest'>,
): Promise<void> {
  appRouter.get('/', () => 'home')
}
`
    const registrar = findRouteRegistrar(source)

    expect(registrar?.parameterName).toBe('appRouter')
    expect(source.slice(registrar!.bodyEnd)).toBe('}\n')
  })

  // `resolveRegistrar` in load-routes.ts calls any exported function value, so
  // these forms boot today and must be wirable.
  it.each([
    ['arrow function', `export const registerWebRoutes = (appRouter: Router): void => {\n  appRouter.get('/', () => 'home')\n}\n`],
    ['named default export', `export default function registerWebRoutes(appRouter: Router): void {\n  appRouter.get('/', () => 'home')\n}\n`],
    ['anonymous default export', `export default function (appRouter: Router): void {\n  appRouter.get('/', () => 'home')\n}\n`],
    ['declaration exported separately', `function registerWebRoutes(appRouter: Router): void {\n  appRouter.get('/', () => 'home')\n}\n\nexport default registerWebRoutes\n`],
  ])('recognizes a registrar declared as a %s', (_shape, source) => {
    expect(findRouteRegistrar(source)?.parameterName).toBe('appRouter')
  })

  it('accepts a router annotated through an import alias', () => {
    const source = `import { Router as AppRouter } from '@guren/core'

export function registerWebRoutes(appRouter: AppRouter): void {
  appRouter.get('/', () => 'home')
}
`
    expect(findRouteRegistrar(source)?.parameterName).toBe('appRouter')
  })

  // Selection is by the name the route loader resolves, not by "takes a
  // Router" — otherwise a helper that happens to accept one is patched, and
  // the call is handed that helper's first parameter.
  it('skips an unrelated exported function that also takes a router', () => {
    const source = `export function buildPrefix(prefix: string, router: Router): void {}

export function registerWebRoutes(baseRouter: Router): void {
  baseRouter.get('/', () => 'home')
}
`
    expect(findRouteRegistrar(source)?.parameterName).toBe('baseRouter')
  })

  // A regex literal is invisible to a string/comment mask, so the old scanner
  // read the braces inside one as a registrar body and patched into it.
  it('ignores a registrar that only exists inside a regex literal', () => {
    const source = `const pattern = /export function fake(router: Router) {}/

export function registerWebRoutes(real: Router): void {
  real.get('/', () => 'home')
}
`
    expect(findRouteRegistrar(source)?.parameterName).toBe('real')
  })

  it('does not let a regex literal in the body close it early', () => {
    const source = `export function registerWebRoutes(router: Router): void {
  const close = /}/
  router.get('/', () => close.source)
}
`
    expect(body(source)).toContain("router.get('/'")
  })

  // An overload signature carries a parameter name but no body; taking the
  // first of each produced a call passing a name that exists in neither.
  it('takes the implementation of an overloaded registrar, not its signature', () => {
    const source = `export function registerWebRoutes(router: Router): void
export function registerWebRoutes(baseRouter: Router): void {
  baseRouter.get('/', () => 'home')
}
`
    expect(findRouteRegistrar(source)?.parameterName).toBe('baseRouter')
  })

  it('skips a registrar that only appears in a comment', () => {
    expect(findRouteRegistrar(`// export function registerWebRoutes(router: Router): void {
const noop = 1
`)).toBeNull()
  })

  it('declines a routes file with no registrar at all', () => {
    expect(findRouteRegistrar(REGISTRAR_LESS_ROUTES_FIXTURE)).toBeNull()
  })

  it('declines source it cannot parse rather than guessing', () => {
    expect(findRouteRegistrar('export function registerWebRoutes(router: Router): void { <<< }\n')).toBeNull()
  })
})

describe('addRouteRegistrarCall', () => {
  const ADMIN_IMPORT = "import registerAdminRoutes from './admin.js'"

  async function seedRoutes(workspace: TempWorkspace, source: string): Promise<string> {
    await mkdir(join(workspace.dir, 'routes'), { recursive: true })
    const target = join(workspace.dir, 'routes/web.ts')
    await writeFile(target, source, 'utf8')
    return target
  }

  it('calls the registrar with its own parameter, not a hardcoded `router`', async () => {
    const workspace = await createTempWorkspace('guren-cli-registrar-call-')
    try {
      const target = await seedRoutes(workspace, BLOG_ROUTES_FIXTURE)

      const result = await addRouteRegistrarCall('routes/web.ts', 'registerAdminRoutes', ADMIN_IMPORT)
      expect(result.modified).toBe(true)

      const content = await readFile(target, 'utf8')
      expect(content).toContain('registerAdminRoutes(baseRouter)')
      // `router` is a `const` declared below the insertion point: passing it
      // here reads it before initialization.
      expect(content).not.toContain('registerAdminRoutes(router)')
      expect(content).toContain(ADMIN_IMPORT)
      expect(content).toContain(`export function registerWebRoutes(baseRouter: Router): void {
  registerAdminRoutes(baseRouter)

  const router = baseRouter`)
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not add a second call when one is already there under another argument', async () => {
    const workspace = await createTempWorkspace('guren-cli-registrar-call-idempotent-')
    try {
      const target = await seedRoutes(workspace, BLOG_ROUTES_FIXTURE)

      await addRouteRegistrarCall('routes/web.ts', 'registerAdminRoutes', ADMIN_IMPORT)
      const second = await addRouteRegistrarCall('routes/web.ts', 'registerAdminRoutes', ADMIN_IMPORT)

      expect(second.modified).toBe(false)
      expect(second.reason).toBe('Already registered')
      const content = await readFile(target, 'utf8')
      expect(content.match(/registerAdminRoutes\(/g)).toHaveLength(1)
      expect(content.match(/import registerAdminRoutes from/g)).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  // A call is a call — a same-named declaration or a mention in a comment is
  // not, and the old text match counted both.
  it('does not mistake a same-named declaration for a wired call', async () => {
    const workspace = await createTempWorkspace('guren-cli-registrar-call-shadow-')
    try {
      const target = await seedRoutes(workspace, `import { Router } from '@guren/core'

// registerAdminRoutes(router) goes here eventually
function registerAdminRoutes(router: Router): void {}

export function registerWebRoutes(baseRouter: Router): void {
  baseRouter.get('/', () => 'home')
}
`)

      const result = await addRouteRegistrarCall('routes/web.ts', 'registerAdminRoutes', ADMIN_IMPORT)

      expect(result.modified).toBe(true)
      expect(await readFile(target, 'utf8')).toContain('registerAdminRoutes(baseRouter)')
    } finally {
      await workspace.cleanup()
    }
  })

  it('leaves a routes file it cannot wire exactly as it was', async () => {
    const workspace = await createTempWorkspace('guren-cli-registrar-call-missing-')
    try {
      const target = await seedRoutes(workspace, REGISTRAR_LESS_ROUTES_FIXTURE)

      const result = await addRouteRegistrarCall('routes/web.ts', 'registerAdminRoutes', ADMIN_IMPORT)

      expect(result.modified).toBe(false)
      expect(result.reason).toBe('Could not find a route registrar')
      // Not even the import: a registrar nothing calls is an unused binding,
      // and the app it was scaffolded into stops compiling under noUnusedLocals.
      expect(await readFile(target, 'utf8')).toBe(REGISTRAR_LESS_ROUTES_FIXTURE)
    } finally {
      await workspace.cleanup()
    }
  })

  it('restores an import removed from an already-wired routes file', async () => {
    const workspace = await createTempWorkspace('guren-cli-registrar-call-reimport-')
    try {
      const target = await seedRoutes(workspace, `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  registerAdminRoutes(router)
}
`)

      const result = await addRouteRegistrarCall('routes/web.ts', 'registerAdminRoutes', ADMIN_IMPORT)

      expect(result.modified).toBe(true)
      const content = await readFile(target, 'utf8')
      expect(content).toContain(ADMIN_IMPORT)
      expect(content.match(/registerAdminRoutes\(/g)).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('distinguishes a missing routes file from an unwirable one', async () => {
    const workspace = await createTempWorkspace('guren-cli-registrar-call-absent-')
    try {
      const result = await addRouteRegistrarCall('routes/web.ts', 'registerAdminRoutes', ADMIN_IMPORT)
      expect(result).toEqual({ modified: false, reason: 'File not found' })
    } finally {
      await workspace.cleanup()
    }
  })
})
