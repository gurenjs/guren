import { describe, test, expect } from 'bun:test'
import type { FC } from 'hono/jsx'
import { jsx } from '../jsx-runtime'
import { Controller, type ViewOptions } from './Controller'

// Plain-TS element builders (no .tsx: the workspace-root typecheck program
// carries no `jsx` compiler option). Going through `../jsx-runtime` also
// exercises the RFC 0014 subpath source directly.
// Returns `never`: a JSXNode is renderable but FC's declared result union
// names it only inside `Child[]`, so the loosest honest type keeps every
// hand-built component assignable to FC without per-site casts.
const h = (tag: string, props: Record<string, unknown> = {}, children?: unknown): never =>
  jsx(tag, children === undefined ? props : { ...props, children }, undefined) as never

class TestController extends Controller {
  render<P>(component: FC<P>, props: P, options?: ViewOptions): Promise<Response> {
    return this.view(component, props, options)
  }
}

const controller = () => new TestController()

const DocPage: FC<{ title: string; body: string }> = ({ title, body }) =>
  h('html', { lang: 'en' }, [
    h('head'),
    h('body', {}, h('article', {}, [h('title', {}, title), h('h1', {}, body)])),
  ]) as never

describe('Controller.view', () => {
  describe('response contract', () => {
    test('should return an html document with doctype and content-type', async () => {
      const res = await controller().render(DocPage, { title: 'T', body: 'B' })
      const html = await res.text()

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(html.startsWith('<!doctype html><html lang="en">')).toBe(true)
      expect(html).not.toContain('__INERTIA_PAGE__')
    })

    test('should honour status, headers, and doctype: false', async () => {
      const Fragment: FC<{ t: string }> = ({ t }) => h('article', {}, t) as never
      const res = await controller().render(Fragment, { t: 'x' }, {
        doctype: false,
        status: 404,
        headers: { 'x-robots-tag': 'noindex' },
      })

      expect(res.status).toBe(404)
      expect(res.headers.get('x-robots-tag')).toBe('noindex')
      expect(await res.text()).toBe('<article>x</article>')
    })

    test('should let a caller-provided content-type win', async () => {
      const Frag: FC<Record<string, never>> = () => h('p', {}, 'x') as never
      const res = await controller().render(Frag, {}, {
        doctype: false,
        headers: { 'content-type': 'text/plain' },
      })
      expect(res.headers.get('content-type')).toBe('text/plain')
    })

    test('should hoist title and meta from the body into head', async () => {
      const res = await controller().render(DocPage, { title: 'Deep', body: 'b' })
      const html = await res.text()
      expect(html).toMatch(/<head>[\s\S]*<title>Deep<\/title>[\s\S]*<\/head>/)
    })
  })

  describe('forgotten-Layout guard', () => {
    test('should throw a descriptive error for a fragment without doctype: false', async () => {
      const Orphan: FC<{ t: string }> = ({ t }) => h('article', {}, t) as never
      await expect(controller().render(Orphan, { t: 'x' })).rejects.toThrow(
        /view\(\): Orphan rendered a fragment, not a document/,
      )
    })

    test('should accept the same fragment when doctype: false marks it intentional', async () => {
      const Orphan: FC<{ t: string }> = ({ t }) => h('article', {}, t) as never
      const res = await controller().render(Orphan, { t: 'x' }, { doctype: false })
      expect(res.status).toBe(200)
    })
  })

  describe('rendering shapes', () => {
    const shapes: Array<[string, FC<{ t: string }>]> = [
      ['sync root', (({ t }) => h('p', {}, t)) as FC<{ t: string }>],
      [
        'async root',
        (async ({ t }) => {
          await new Promise((resolve) => setTimeout(resolve, 1))
          return h('p', {}, t)
        }) as FC<{ t: string }>,
      ],
      [
        'nested async child',
        (({ t }) => {
          const Slow: FC<{ t: string }> = async ({ t: inner }) => {
            await new Promise((resolve) => setTimeout(resolve, 1))
            return h('em', {}, inner) as never
          }
          return h('div', {}, jsx(Slow as never, { t }, undefined)) as never
        }) as FC<{ t: string }>,
      ],
    ]

    for (const [name, component] of shapes) {
      test(`should render and escape a ${name}`, async () => {
        const res = await controller().render(component, { t: '<x>' }, { doctype: false })
        const html = await res.text()
        expect(html).toContain('&lt;x&gt;')
        expect(html).not.toContain('<x>')
      })
    }

    test('should render a null-returning component as an empty body', async () => {
      const Empty: FC<Record<string, never>> = () => null
      const res = await controller().render(Empty, {}, { doctype: false })
      expect(await res.text()).toBe('')
    })
  })

  describe('escaping boundary (security regressions)', () => {
    test('should escape a raw string inside a Child[] (the RFC 0014 XSS regression)', async () => {
      const RawArray: FC<Record<string, never>> = () =>
        ['<script>alert(1)</script>', h('p', {}, 'ok')] as never
      const res = await controller().render(RawArray, {}, { doctype: false })
      const html = await res.text()

      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
      expect(html).not.toContain('<script>')
    })

    test('should escape a Promise<string> inside a Child[]', async () => {
      const PromiseArray: FC<Record<string, never>> = () =>
        [Promise.resolve('<b>raw</b>'), h('p', {}, 'ok')] as never
      const res = await controller().render(PromiseArray, {}, { doctype: false })
      const html = await res.text()

      expect(html).toContain('&lt;b&gt;raw&lt;/b&gt;')
      expect(html).not.toContain('<b>raw</b>')
    })

    test('should escape attribute breakout attempts', async () => {
      const Link: FC<{ href: string }> = ({ href }) => h('a', { href }, 'x') as never
      const res = await controller().render(Link, { href: '" onmouseover="alert(1)' }, { doctype: false })
      expect(await res.text()).toBe('<a href="&quot; onmouseover=&quot;alert(1)">x</a>')
    })

    test('should pass a javascript: URL through verbatim (scheme validation is the caller\'s job)', async () => {
      // Pins the documented boundary: view() escapes markup, not URL schemes.
      // Content that carries user-supplied URLs must be sanitized upstream
      // (e.g. @guren/plugin-markdown's allowlist).
      const Link: FC<{ href: string }> = ({ href }) => h('a', { href }, 'x') as never
      const res = await controller().render(Link, { href: 'javascript:alert(1)' }, { doctype: false })
      expect(await res.text()).toBe('<a href="javascript:alert(1)">x</a>')
    })
  })

  describe('error propagation', () => {
    test('should propagate a throwing component like any throwing action', async () => {
      const Boom: FC<Record<string, never>> = () => {
        throw new Error('kaboom')
      }
      await expect(controller().render(Boom, {})).rejects.toThrow('kaboom')
    })
  })
})
