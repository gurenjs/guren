import { describe, test, expect } from 'bun:test'

import { createMarkdownRenderer } from './renderer'

describe('createMarkdownRenderer', () => {
  describe('rendering defaults', () => {
    test('should render a heading with a slug id', async () => {
      const renderer = createMarkdownRenderer()
      expect(await renderer.render('# Hello World')).toBe('<h1 id="hello-world">Hello World</h1>\n')
    })

    test('should deduplicate repeated heading ids within one render', async () => {
      const renderer = createMarkdownRenderer()
      const html = await renderer.render('# Setup\n\n# Setup')
      expect(html).toContain('id="setup"')
      expect(html).toContain('id="setup-1"')
    })

    test('should keep slug state independent across renders', async () => {
      const renderer = createMarkdownRenderer()
      expect(await renderer.render('# Setup')).toContain('id="setup"')
      expect(await renderer.render('# Setup')).toContain('id="setup"')
    })

    test('should render GFM tables and strikethrough', async () => {
      const renderer = createMarkdownRenderer()
      const html = await renderer.render('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n~~gone~~')
      expect(html).toContain('<table>')
      expect(html).toContain('<del>gone</del>')
    })

    test('should skip heading ids when anchors is false', async () => {
      const renderer = createMarkdownRenderer({ anchors: false })
      expect(await renderer.render('# Hello')).toBe('<h1>Hello</h1>\n')
    })
  })

  describe('alerts', () => {
    test('should render a note alert with label and body', async () => {
      const renderer = createMarkdownRenderer()
      const html = await renderer.render('> [!NOTE]\n> Something useful.')
      expect(html).toContain('class="guren-markdown-alert guren-markdown-alert--note"')
      expect(html).toContain('class="guren-markdown-alert__label"')
      expect(html).toContain('Note')
      expect(html).toContain('<p>Something useful.</p>')
      expect(html).not.toContain('[!NOTE]')
    })

    test('should keep the alert directive on the same line as text', async () => {
      const renderer = createMarkdownRenderer()
      const html = await renderer.render('> [!WARNING] Mind the gap.')
      expect(html).toContain('guren-markdown-alert--warning')
      expect(html).toContain('Mind the gap.')
      expect(html).not.toContain('[!WARNING]')
    })

    test('should leave plain blockquotes untouched', async () => {
      const renderer = createMarkdownRenderer()
      const html = await renderer.render('> Just a quote.')
      expect(html).toContain('<blockquote>')
      expect(html).not.toContain('guren-markdown-alert')
    })

    test('should render the directive literally when alerts is false', async () => {
      const renderer = createMarkdownRenderer({ alerts: false })
      const html = await renderer.render('> [!NOTE]\n> Body.')
      expect(html).toContain('<blockquote>')
      expect(html).toContain('[!NOTE]')
      expect(html).not.toContain('guren-markdown-alert')
    })

    test('should survive the default sanitizer', async () => {
      const renderer = createMarkdownRenderer()
      const html = await renderer.render('> [!CAUTION]\n> Careful.')
      // The sanitizer's allowedClasses must admit the alert markup verbatim.
      expect(html).toContain('guren-markdown-alert--caution')
      expect(html).toContain('guren-markdown-alert__body')
    })
  })

  describe('sanitization (default on)', () => {
    test('should drop javascript: URLs from links', async () => {
      const renderer = createMarkdownRenderer()
      const html = await renderer.render('[click](javascript:alert(1))')
      expect(html).not.toContain('javascript:')
      expect(html).toContain('click')
    })

    test('should drop data: URLs from images', async () => {
      const renderer = createMarkdownRenderer()
      const html = await renderer.render('![x](data:text/html;base64,PHNjcmlwdD4=)')
      expect(html).not.toContain('data:')
    })

    test('should drop protocol-relative URLs', async () => {
      const renderer = createMarkdownRenderer()
      const html = await renderer.render('[x](//evil.example/a)')
      expect(html).not.toContain('//evil.example')
    })

    test('should escape raw HTML script tags', async () => {
      const renderer = createMarkdownRenderer()
      const html = await renderer.render('hello <script>alert(1)</script>')
      expect(html).not.toContain('<script>')
      expect(html).toContain('&lt;script&gt;')
    })

    test('should strip event handler attributes from raw HTML', async () => {
      const renderer = createMarkdownRenderer()
      const html = await renderer.render('<img src="x.png" onerror="alert(1)">')
      expect(html).not.toContain('onerror')
    })

    test('should strip disallowed inline styles but keep shiki-shaped ones', async () => {
      const renderer = createMarkdownRenderer()
      const html = await renderer.render(
        '<span style="color:#ff0000;position:fixed">a</span> <span style="--shiki-dark:#bbbbbb">b</span>',
      )
      expect(html).toContain('color:#ff0000')
      expect(html).not.toContain('position')
      expect(html).toContain('--shiki-dark:#bbbbbb')
    })

    test('should drop foreign class values while keeping alert classes', async () => {
      const renderer = createMarkdownRenderer()
      const html = await renderer.render('<div class="guren-markdown-alert evil">x</div>')
      expect(html).toContain('guren-markdown-alert')
      expect(html).not.toContain('evil')
    })

    test('should pass raw HTML through when sanitize is false', async () => {
      const renderer = createMarkdownRenderer({ sanitize: false })
      const html = await renderer.render('hello <script>alert(1)</script>')
      expect(html).toContain('<script>alert(1)</script>')
    })

    test('should extend the allowlist via the sanitize callback', async () => {
      const renderer = createMarkdownRenderer({
        sanitize: (defaults) => ({
          ...defaults,
          allowedTags: [...(defaults.allowedTags as string[]), 'video'],
        }),
      })
      const html = await renderer.render('<video controls></video>')
      expect(html).toContain('<video')
    })
  })

  describe('hooks', () => {
    test('should rewrite link hrefs via rewriteLink', async () => {
      const renderer = createMarkdownRenderer({
        rewriteLink: (href) => (href.endsWith('.md') ? `/docs/${href.replace(/\.md$/, '')}` : href),
      })
      const html = await renderer.render('[guide](routing.md) and [home](https://example.com/)')
      expect(html).toContain('href="/docs/routing"')
      expect(html).toContain('href="https://example.com/"')
    })

    test('should highlight fenced code through the highlight hook', async () => {
      const renderer = createMarkdownRenderer({
        highlight: async (code, lang) => `<pre class="hl" data-lang="${lang ?? ''}">${code}</pre>`,
      })
      const html = await renderer.render('```ts\nconst a = 1\n```')
      expect(html).toContain('class="hl"')
      expect(html).toContain('const a = 1')
    })

    test('should render fences as plain pre/code without a highlighter', async () => {
      const renderer = createMarkdownRenderer()
      const html = await renderer.render('```ts\nconst a = 1\n```')
      expect(html).toContain('<pre>')
      expect(html).toContain('const a = 1')
    })
  })

  describe('known-answer fixture', () => {
    // Freezes the wrapped libraries' observable behavior: a marked or
    // sanitize-html upgrade that changes output must fail here loudly
    // instead of shifting silently under consumers.
    test('should render the fixture document byte-for-byte', async () => {
      const renderer = createMarkdownRenderer()
      const fixture = [
        '# Title',
        '',
        'Intro with **bold**, a [link](https://example.com/), and `code`.',
        '',
        '> [!TIP]',
        '> Use fixtures.',
        '',
        '- one',
        '- two',
      ].join('\n')

      expect(await renderer.render(fixture)).toBe(
        '<h1 id="title">Title</h1>\n' +
          '<p>Intro with <strong>bold</strong>, a <a href="https://example.com/">link</a>, and <code>code</code>.</p>\n' +
          '<div class="guren-markdown-alert guren-markdown-alert--tip">\n' +
          '  <p class="guren-markdown-alert__label">Tip</p>\n' +
          '  <div class="guren-markdown-alert__body">\n' +
          '<p>Use fixtures.</p>\n' +
          '\n  </div>\n' +
          '</div><ul>\n<li>one</li>\n<li>two</li>\n</ul>\n',
      )
    })
  })
})
