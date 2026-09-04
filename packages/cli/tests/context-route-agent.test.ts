import { describe, it, expect } from 'bun:test'
import {
  Router,
  authorizeMiddleware,
  authorizeAllMiddleware,
  authorizeResourceMiddleware,
} from '@guren/core'
import { routeDefinitionToContextRoute } from '../src/context-route'

const handler = () => new Response('ok')

/**
 * Driven through a real `Router`: the metadata and the authorization
 * capability only reach a `ContextRoute` that way, so a hand-built definition
 * would prove nothing about the conversion.
 */
describe('routeDefinitionToContextRoute — agent metadata', () => {
  it('carries declared agent metadata through verbatim', () => {
    const router = new Router()
    router.post(
      '/posts',
      {
        name: 'posts.store',
        agent: { description: 'Create a post.', approval: 'required', redact: ['token'] },
      },
      handler,
    )

    const [route] = router.definitions().map(routeDefinitionToContextRoute)

    expect(route?.agent).toEqual({
      description: 'Create a post.',
      approval: 'required',
      redact: ['token'],
    })
  })

  it('leaves agent undefined on a route that declares none', () => {
    const router = new Router()
    router.get('/posts', { name: 'posts.index' }, handler)

    const [route] = router.definitions().map(routeDefinitionToContextRoute)

    expect(route?.agent).toBeUndefined()
  })

  it('derives the single ability an authorize() chain enforces', () => {
    const router = new Router()
    router
      .delete('/posts/:id', { name: 'posts.destroy', agent: {} }, handler)
      .middleware(authorizeMiddleware('posts.destroy'))

    const [route] = router.definitions().map(routeDefinitionToContextRoute)

    expect(route?.authorization).toMatchObject({ ability: 'posts.destroy', mode: 'all' })
  })

  // `any`-of has no single ability, so nothing may be picked out of the list.
  it('reports an any-of chain as enforced without a derivable ability', () => {
    const router = new Router()
    router
      .delete('/posts/:id', { name: 'posts.destroy', agent: {} }, handler)
      .middleware(authorizeMiddleware(['posts.destroy', 'posts.moderate']))

    const [route] = router.definitions().map(routeDefinitionToContextRoute)

    expect(route?.authorization?.ability).toBeUndefined()
    expect(route?.authorization?.abilities).toEqual(['posts.destroy', 'posts.moderate'])
  })

  // Two all-of checks stay 'all', but two abilities are still not one.
  it('reports two conjoined abilities without picking one', () => {
    const router = new Router()
    router
      .delete('/posts/:id', { name: 'posts.destroy', agent: {} }, handler)
      .middleware(authorizeAllMiddleware(['posts.destroy', 'posts.publish']))

    const [route] = router.definitions().map(routeDefinitionToContextRoute)

    expect(route?.authorization?.ability).toBeUndefined()
  })

  it('records a method-map resolution rather than naming an ability', () => {
    const router = new Router()
    router
      .delete('/posts/:id', { name: 'posts.destroy', agent: {} }, handler)
      .middleware(authorizeResourceMiddleware(() => ({})))

    const [route] = router.definitions().map(routeDefinitionToContextRoute)

    expect(route?.authorization?.ability).toBeUndefined()
    expect(route?.authorization?.fromMethodMap).toBe(true)
  })

  // An abilityFor callback wins over the verb map, so the map is not
  // authoritative and nothing static can name the ability.
  it('marks an abilityFor override as not resolvable from the method map', () => {
    const router = new Router()
    router
      .delete('/posts/:id', { name: 'posts.destroy', agent: {} }, handler)
      .middleware(authorizeResourceMiddleware(() => ({}), { abilityFor: () => 'purge' }))

    const [route] = router.definitions().map(routeDefinitionToContextRoute)

    expect(route?.authorization?.fromMethodMap).toBe(false)
  })

  it('leaves authorization undefined when nothing in the chain authorizes', () => {
    const router = new Router()
    router.delete('/posts/:id', { name: 'posts.destroy', agent: {} }, handler)

    const [route] = router.definitions().map(routeDefinitionToContextRoute)

    expect(route?.authorization).toBeUndefined()
  })
})
