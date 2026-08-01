import { describe, expect, test } from 'bun:test'
import { renderDebugPage } from './debug-page'

interface RenderedFrame {
  func: string
  location: string
}

const FRAME_PATTERN = /<span class="frame-method">([^<]*)<\/span>\s*<span class="frame-location">([^<]*)<\/span>/g

/** Inverse of the page's own escaper, over the entities these fixtures produce. */
function unescapeHtml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function pageFor(...frames: string[]): string {
  const error = new Error('boom')
  error.stack = ['Error: boom', ...frames].join('\n')
  return renderDebugPage(error)
}

/**
 * The frames a rendered page shows, which is the only form a developer ever
 * sees — `parseStackTrace` itself is internal, and asserting on it would let the
 * two halves of a frame be reported under the wrong headings unnoticed.
 */
function framesIn(html: string): RenderedFrame[] {
  return [...html.matchAll(FRAME_PATTERN)].map(([, func, location]) => ({
    func: unescapeHtml(func),
    location: unescapeHtml(location),
  }))
}

function framesOf(...frames: string[]): RenderedFrame[] {
  return framesIn(pageFor(...frames))
}

describe('renderDebugPage stack frames', () => {
  test('should read a frame that carries a function name', () => {
    expect(framesOf('    at makeStore (/app/config/cache.ts:3:18)')).toEqual([
      { func: 'makeStore', location: '/app/config/cache.ts:3:18' },
    ])
  })

  test('should read a bare frame as anonymous', () => {
    expect(framesOf('    at /app/config/cache.ts:3:18')).toEqual([
      { func: '<anonymous>', location: '/app/config/cache.ts:3:18' },
    ])
  })

  test('should keep a path that contains parentheses intact', () => {
    // Ordinary on macOS — a checkout under `~/Projects (old)`. The path is
    // bounded by the `(` that matches the frame's final `)`, not by the last one
    // the frame happens to contain: taking that one reports the file as
    // `old)/app/config/cache.ts`, a path that exists nowhere.
    expect(framesOf('    at makeStore (/Users/me/Projects (old)/app/config/cache.ts:3:18)')).toEqual([
      { func: 'makeStore', location: '/Users/me/Projects (old)/app/config/cache.ts:3:18' },
    ])

    expect(framesOf('    at /Users/me/Projects (old)/app/config/cache.ts:3:18')).toEqual([
      { func: '<anonymous>', location: '/Users/me/Projects (old)/app/config/cache.ts:3:18' },
    ])
  })

  test('should keep a path that contains spaces intact', () => {
    expect(framesOf('    at /Users/me/My Projects/app/config/cache.ts:3:18')).toEqual([
      { func: '<anonymous>', location: '/Users/me/My Projects/app/config/cache.ts:3:18' },
    ])
  })

  test('should read past a function name that contains parentheses', () => {
    // Emitted for a method whose key carries parentheses:
    //   ({ 'weird (name)'() {} })['weird (name)']()
    // Here the *rightmost* `(` is the correct one — the opposite of the case
    // above, which is why neither end of the frame can be trusted on its own.
    expect(framesOf('    at weird (name) (/app/config/cache.ts:3:18)')).toEqual([
      { func: 'weird (name)', location: '/app/config/cache.ts:3:18' },
    ])
  })

  test('should split a frame whose name and path both contain parentheses', () => {
    // One developer's checkout directory away from the case above, and the
    // reason the split counts nesting depth rather than preferring one end:
    // every fixed choice of `(` gets this frame wrong.
    expect(framesOf('    at weird (name) (/app (old)/config/cache.ts:3:18)')).toEqual([
      { func: 'weird (name)', location: '/app (old)/config/cache.ts:3:18' },
    ])
  })

  test('should keep a path that contains an unmatched closing parenthesis', () => {
    // Nothing in the frame closes it, so counting depth alone runs off the
    // front and would drop the frame rather than show the location sitting
    // right there. Rarer than the case above, but a lost frame is worse than a
    // mis-split one.
    expect(framesOf('    at makeStore (/app/name).ts:3:18)')).toEqual([
      { func: 'makeStore', location: '/app/name).ts:3:18' },
    ])
  })

  test('should drop a frame that names no location', () => {
    expect(framesOf('    at Object.<anonymous>', '    at makeStore (/app/config/cache.ts:3:18)')).toEqual([
      { func: 'makeStore', location: '/app/config/cache.ts:3:18' },
    ])
  })

  test('should drop a frame that carries a line but no column', () => {
    // Unlike the hot-reload registry, which keys owners on the path alone and
    // so accepts a bare `:line`, this page prints `file:line:col` and has
    // nothing to show for a frame missing either half.
    expect(framesOf('    at makeStore (/app/config/cache.ts:3)')).toEqual([])
  })

  test('should report how many frames it parsed', () => {
    const html = pageFor('    at a (/app/x.ts:1:2)', '    at b (/app/y.ts:3:4)')

    expect(html).toContain('<span class="badge">2 frames</span>')
  })

  test('should say so when there is no stack trace', () => {
    const error = new Error('boom')
    error.stack = undefined

    expect(renderDebugPage(error)).toContain('No stack trace available.')
  })

  test('should HTML-escape frames so a crafted path cannot inject markup', () => {
    const html = pageFor('    at <script>alert(1)</script> (/app/<img src=x>.ts:3:18)')

    // Both halves, from the one render: the markup must be inert *and* still
    // shown — a frame that was silently dropped would also pass `not.toContain`.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(framesIn(html)).toEqual([
      { func: '<script>alert(1)</script>', location: '/app/<img src=x>.ts:3:18' },
    ])
  })
})
