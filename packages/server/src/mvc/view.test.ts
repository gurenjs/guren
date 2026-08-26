import { describe, test, expect } from 'bun:test'
import type { FC } from 'hono/jsx'
import { raw } from 'hono/html'
import { jsx } from '../jsx-runtime'
import { renderDocument } from './view'
import { Controller } from './Controller'

// Plain-TS element builder (no .tsx: the workspace-root typecheck program
// carries no `jsx` compiler option). Returns `never` so hand-built
// components are assignable to FC.
const h = (tag: string, props: Record<string, unknown> = {}, children?: unknown): never =>
  jsx(tag, children === undefined ? props : { ...props, children }, undefined) as never

const DocPage: FC<{ title: string; body: string }> = ({ title, body }) =>
  h('html', { lang: 'en' }, [
    h('head'),
    h('body', {}, h('article', {}, [h('title', {}, title), h('h1', {}, body)])),
  ])

const Orphan: FC<{ t: string }> = ({ t }) => h('article', {}, t)

describe('renderDocument', () => {
  describe('response contract', () => {
    test('should return an html document with doctype and content-type', async () => {
      const res = await renderDocument(DocPage, { title: 'T', body: 'B' })
      const html = await res.text()

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(html.startsWith('<!doctype html><html lang="en">')).toBe(true)
      expect(html).not.toContain('__INERTIA_PAGE__')
    })

    test('should honour status, headers, and doctype: false', async () => {
      const res = await renderDocument(Orphan, { t: 'x' }, {
        doctype: false,
        status: 404,
        headers: { 'x-robots-tag': 'noindex' },
      })

      expect(res.status).toBe(404)
      expect(res.headers.get('x-robots-tag')).toBe('noindex')
      expect(await res.text()).toBe('<article>x</article>')
    })

    test('should let a caller-provided content-type win', async () => {
      const res = await renderDocument(Orphan, { t: 'x' }, {
        doctype: false,
        headers: { 'content-type': 'text/plain' },
      })
      expect(res.headers.get('content-type')).toBe('text/plain')
    })

    test('should hoist title and meta from the body into head', async () => {
      const res = await renderDocument(DocPage, { title: 'Deep', body: 'b' })
      const html = await res.text()
      expect(html).toMatch(/<head>[\s\S]*<title>Deep<\/title>[\s\S]*<\/head>/)
    })
  })

  describe('forgotten-Layout guard', () => {
    test('should throw a descriptive error for a fragment without doctype: false', async () => {
      await expect(renderDocument(Orphan, { t: 'x' })).rejects.toThrow(
        /view\(\): Orphan rendered a fragment, not a document/,
      )
    })

    test('should accept the same fragment when doctype: false marks it intentional', async () => {
      const res = await renderDocument(Orphan, { t: 'x' }, { doctype: false })
      expect(res.status).toBe(200)
    })

    test('should accept a document behind a leading comment', async () => {
      // A plain string child would be escaped; a genuine leading comment
      // reaches the output only as raw markup (e.g. a build banner).
      const WithComment: FC<Record<string, never>> = () =>
        [raw('<!--banner-->'), h('html', {}, h('body', {}, 'x'))] as never
      const res = await renderDocument(WithComment, {})
      expect(res.status).toBe(200)
      expect((await res.text()).startsWith('<!doctype html><!--banner--><html>')).toBe(true)
    })

    test('should scan adversarial comment runs in linear time (CodeQL js/redos regression)', async () => {
      // The regex form of this guard backtracked exponentially on
      // '<!--' + '--><!--' * n with no closing root. ~30k repetitions hung
      // for minutes; the linear scanner must reject it instantly.
      const Adversarial: FC<Record<string, never>> = () =>
        [raw('<!--' + '--><!--'.repeat(30_000))] as never
      const started = performance.now()
      await expect(renderDocument(Adversarial, {})).rejects.toThrow(/rendered a fragment/)
      expect(performance.now() - started).toBeLessThan(1_000)
    })
  })

  describe('rendering shapes', () => {
    const shapes: Array<[string, FC<{ t: string }>]> = [
      ['sync root', ({ t }) => h('p', {}, t)],
      [
        'async root',
        async ({ t }) => {
          await new Promise((resolve) => setTimeout(resolve, 1))
          return h('p', {}, t)
        },
      ],
      [
        'nested async child',
        ({ t }) => {
          const Slow: FC<{ t: string }> = async ({ t: inner }) => {
            await new Promise((resolve) => setTimeout(resolve, 1))
            return h('em', {}, inner)
          }
          return h('div', {}, jsx(Slow as never, { t }, undefined))
        },
      ],
    ]

    for (const [name, component] of shapes) {
      test(`should render and escape a ${name}`, async () => {
        const res = await renderDocument(component, { t: '<x>' }, { doctype: false })
        const html = await res.text()
        expect(html).toContain('&lt;x&gt;')
        expect(html).not.toContain('<x>')
      })
    }

    test('should render a null-returning component as an empty body', async () => {
      const Empty: FC<Record<string, never>> = () => null
      const res = await renderDocument(Empty, {}, { doctype: false })
      expect(await res.text()).toBe('')
    })
  })

  describe('escaping boundary (security regressions)', () => {
    test('should escape a raw string inside a Child[] (the RFC 0014 XSS regression)', async () => {
      const RawArray: FC<Record<string, never>> = () =>
        ['<script>alert(1)</script>', h('p', {}, 'ok')] as never
      const res = await renderDocument(RawArray, {}, { doctype: false })
      const html = await res.text()

      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
      expect(html).not.toContain('<script>')
    })

    test('should escape a Promise<string> inside a Child[]', async () => {
      const PromiseArray: FC<Record<string, never>> = () =>
        [Promise.resolve('<b>raw</b>'), h('p', {}, 'ok')] as never
      const res = await renderDocument(PromiseArray, {}, { doctype: false })
      const html = await res.text()

      expect(html).toContain('&lt;b&gt;raw&lt;/b&gt;')
      expect(html).not.toContain('<b>raw</b>')
    })

    test('should escape attribute breakout attempts', async () => {
      const Link: FC<{ href: string }> = ({ href }) => h('a', { href }, 'x')
      const res = await renderDocument(Link, { href: '" onmouseover="alert(1)' }, { doctype: false })
      expect(await res.text()).toBe('<a href="&quot; onmouseover=&quot;alert(1)">x</a>')
    })

    test('should pass a javascript: URL through verbatim (scheme validation is the caller\'s job)', async () => {
      // Pins the documented boundary: rendering escapes markup, not URL
      // schemes. Content carrying user-supplied URLs must be sanitized
      // upstream (e.g. @guren/plugin-markdown's allowlist).
      const Link: FC<{ href: string }> = ({ href }) => h('a', { href }, 'x')
      const res = await renderDocument(Link, { href: 'javascript:alert(1)' }, { doctype: false })
      expect(await res.text()).toBe('<a href="javascript:alert(1)">x</a>')
    })
  })

  describe('error propagation', () => {
    test('should propagate a throwing component like any throwing action', async () => {
      const Boom: FC<Record<string, never>> = () => {
        throw new Error('kaboom')
      }
      await expect(renderDocument(Boom, {})).rejects.toThrow('kaboom')
    })
  })
})

describe('Controller.view', () => {
  test('should delegate to renderDocument with options intact', async () => {
    class TestController extends Controller {
      run() {
        return this.view(Orphan, { t: '<x>' }, { doctype: false, status: 201 })
      }
    }
    const res = await new TestController().run()
    expect(res.status).toBe(201)
    expect(await res.text()).toBe('<article>&lt;x&gt;</article>')
  })
})
