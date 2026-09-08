import { z } from 'zod'
import { Application } from '../../src/http/Application'
import { prototype, type PrototypeFixtureLoader } from '../../src/mvc/prototype'
import { Router } from '../../src/mvc/Router'

/**
 * A type-only fixture (RFC 0021 Part 2): `bun run typecheck` is the assertion.
 * The contract-options overloads once rejected `prototype`, and a fixture the
 * client typed against its own manifest was not assignable to
 * `createApp({ prototype })` (its context is contravariant with any concrete
 * server context). Both shapes below are what `make:feature --prototype` prints.
 */

const PayloadSchema = z.object({ title: z.string() })

const router = new Router()
router.get('/notes', prototype).name('notes.index')
router.get('/notes/:id', prototype).name('notes.show')
router.post('/notes', { name: 'notes.store', body: PayloadSchema }, prototype)
router.put('/notes/:id', { name: 'notes.update', body: PayloadSchema }, prototype)
router.delete('/notes/:id', { name: 'notes.destroy' }, prototype)
router.query('/notes/search', { name: 'notes.search', body: PayloadSchema }, prototype)
router.on('PURGE', '/notes/:id', { name: 'notes.purge' }, prototype)

const guard = async (_ctx: unknown, next: () => Promise<void>) => {
  await next()
}
router.middleware(guard).get('/notes/:id/edit', prototype).name('notes.edit')
router.middleware(guard).post('/notes/bulk', { name: 'notes.bulk', body: PayloadSchema }, prototype)

/** The shape the client's `definePrototype()` gives a handler: its own context type, its own result union. */
type ClientContext = {
  params: { id: string }
  query: Record<string, string | string[]>
  body: { title: string }
  state: { notes: { id: number; title: string }[] }
  page(contract: { id: string }, props: Record<string, unknown>): { kind: 'page'; component: string; props: Record<string, unknown> }
  redirect(to: 'notes.index' | 'notes.show', params?: { id: number }): { kind: 'redirect'; to: string; params?: Record<string, string | number> }
}

const clientFixture = {
  manifest: { 'notes.index': { method: 'GET', path: '/notes' } } as const,
  routes: {
    'notes.index': ({ state, page }: ClientContext) => page({ id: 'notes/Index' }, { notes: state.notes }),
    'notes.store': ({ state, body, redirect }: ClientContext) => {
      state.notes.push({ id: 1, ...body })
      return redirect('notes.show', { id: 1 })
    },
  },
}

const loader: PrototypeFixtureLoader = async () => ({ default: clientFixture })

export const app = new Application({ routes: () => {}, prototype: loader })
export const inlineApp = new Application({ prototype: async () => clientFixture })
