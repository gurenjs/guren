import { describe, expect, it } from 'bun:test'
import { inertia } from '../../src'

describe('InertiaEngine SSR integration', () => {
  it('renders client-side shell when no SSR renderer is configured', async () => {
    const response = await inertia('Dashboard', { stats: { users: 2 } }, { url: '/dashboard' })
    const body = await response.text()

    expect(body).toContain('id="app"')
    expect(body).toContain('data-page=')
    expect(body).not.toContain('<title>SSR Title</title>')
  })

  it('utilizes provided SSR renderer when available', async () => {
    const response = await inertia(
      'Dashboard',
      { stats: { users: 2 } },
      {
        url: '/dashboard',
        ssr: {
          render: async () => ({
            head: ['<title>SSR Title</title>'],
            body: '<div id="app" data-page="{&quot;component&quot;:&quot;Dashboard&quot;}" data-ssr="true">SSR</div>',
          }),
        },
      },
    )

    const body = await response.text()

    expect(body).toContain('<title>SSR Title</title>')
    expect(body).toContain('data-ssr="true"')
    expect(body).toContain('SSR')
  })
})
