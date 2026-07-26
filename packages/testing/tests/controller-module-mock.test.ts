import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@guren/server'
import { createControllerContext, createControllerModuleMock } from '../src/controller'

// Apps mock `@guren/core`, which re-exports `@guren/server` plus an ORM
// allowlist; mocking server here covers everything but that allowlist.
vi.mock('@guren/server', () => createControllerModuleMock())

// Loading this controller loads a module's `index.ts`, which calls
// `defineModule()` and evaluates its providers.
import CatalogController from './__fixtures__/app/Http/Controllers/CatalogController.js'
import { widgetModule } from './__fixtures__/widgets/index.js'

describe('createControllerModuleMock with an application module', () => {
  it('loads a controller that imports a module index', async () => {
    const controller = new CatalogController()
    controller.setContext(createControllerContext('http://example.com/catalog') as unknown as Context)

    const response = controller.index()

    expect(await response.text()).toBe('gauge')
  })

  it('leaves a route registrar importable without mocking its call-time deps', () => {
    // The registrar reaches `requireAuthenticated`, which the mock does not
    // carry — harmless, because only what a module index touches at import
    // time has to be mocked. Registering routes needs a real router.
    expect(() => widgetModule.routes?.({} as never)).toThrow(/requireAuthenticated/)
  })
})
