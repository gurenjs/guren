import { describe, expect, test } from 'bun:test'

import { composePlanTemplate, PLAN_SCRIPT_PLACEHOLDER } from '../src/plan/page-bundle'
import { escapeJsonForScript, planTemplateSource, renderPlanHtml } from '../src/plan/render'
import { PLAN_VERSION } from '../src/plan/schema'
import { planDataBlock, planPageData } from './plan-fixture'
import { openPlanPage, pageSentences, type Page } from './plan-page-dom'
import { richPlan } from './plan-page-rich'

/** The script the template ships, as the browser is handed it. */
const bundle = (() => {
  const source = planTemplateSource()
  const start = source.lastIndexOf('<script>') + '<script>'.length
  return source.slice(start, source.lastIndexOf('</script>'))
})()

describe('the plan page bundle', () => {
  test('should be one classic script in strict mode, with no module syntax left', () => {
    expect(bundle.startsWith('"use strict";\n(() => {')).toBe(true)
    expect(bundle.trimEnd().endsWith('})();')).toBe(true)
    expect(bundle).not.toMatch(/^\s*(import|export)\b/m)
    expect(bundle).not.toMatch(/\brequire\(|\bimport\.meta\b/)
  })

  test('should not carry the schema validator into the page', () => {
    expect(bundle).not.toMatch(/zod/i)
    // The page's own modules and the one constant they import: nothing else is bundled.
    expect([...bundle.matchAll(/^ {2}\/\/ (\S+\.ts)$/gm)].map((match) => match[1]).filter((path) => path.includes('/'))).toEqual([
      '../version.ts',
    ])
  })

  test('should keep every identifier as the source names it', () => {
    for (const name of ['idMap', 'drawFlow', 'renderModels', 'reviewControls', 'formatInto']) {
      expect(bundle).toContain(`function ${name}(`)
    }
  })

  test('should name no path of the machine that built it', () => {
    expect(bundle).not.toContain(import.meta.dir.split('/').slice(0, 3).join('/'))
  })

  test('should write an href in the three places the modules do', () => {
    expect(bundle.match(/href/g)).toHaveLength(3)
  })
})

describe('composePlanTemplate', () => {
  const html = `<body><script>${PLAN_SCRIPT_PLACEHOLDER}</script></body>`

  test('should write a replacement pattern the script spells as it is spelled', () => {
    const script = "var a = '$&'; var b = '$`'; var c = \"$'\"; var d = '$1'"

    expect(composePlanTemplate(html, script)).toBe(`<body><script>${script}</script></body>`)
  })

  test.each(['var a = "</script>"', 'var a = "</SCRIPT "', 'var a = "<!--"'])('should refuse %p, which would end the block', (script) => {
    expect(() => composePlanTemplate(html, script)).toThrow('would end its script block')
  })

  test.each([['none', '<body></body>'], ['two', html + html]])('should refuse a template naming its script %s times', (_name, template) => {
    expect(() => composePlanTemplate(template, 'var a')).toThrow('must name it once')
  })
})

describe('a plan of a version the page was not built for', () => {
  function openWithVersion(version: unknown, uiLocale: 'en' | 'ja' = 'en'): Page {
    const html = renderPlanHtml({ plan: richPlan(), uiLocale })
    const data = planPageData(html)
    ;(data.plan as { planVersion: unknown }).planVersion = version
    return openPlanPage(html.replace(planDataBlock(html), () => escapeJsonForScript(JSON.stringify(data))))
  }

  test('should say so, naming both versions', () => {
    const page = openWithVersion(PLAN_VERSION + 1)

    expect(page.byId('plan-title').textContent).toBe('This page cannot show this plan')
    expect(page.byId('plan-summary').textContent).toContain(`planVersion ${PLAN_VERSION + 1}`)
    expect(page.byId('plan-summary').textContent).toContain(`built for planVersion ${PLAN_VERSION}`)
  })

  test('should say so in ja', () => {
    const page = openWithVersion(PLAN_VERSION + 1, 'ja')

    expect(page.byId('plan-title').textContent).toBe('このページではこのプランを表示できません')
    expect(page.byId('plan-summary').getAttribute('lang')).toBe('ja')
  })

  test('should draw nothing of the plan', () => {
    const page = openWithVersion(PLAN_VERSION + 1)

    expect(page.document.body.withClass('card')).toEqual([])
    expect(page.byId('panels').childNodes).toEqual([])
    for (const id of ['plan-meta', 'plan-scope', 'questions', 'tabs', 'controls', 'panels', 'footer']) {
      expect(page.byId(id).shown).toBe(false)
    }
    const said = pageSentences(page.document.body).join('\n')
    expect(said).not.toContain(richPlan().title)
    expect(said).not.toContain(richPlan().summary)
  })

  test.each([[undefined], ['1'], [null], ['</script><script>alert(1)</script>']])('should refuse %p as text', (version) => {
    const page = openWithVersion(version)

    expect(page.byId('plan-summary').textContent).toContain(`planVersion ${String(version)},`)
    expect(page.document.body.withTag('script').map((node) => node.id)).toEqual(['plan-data'])
  })

  test('should draw the version it was built for', () => {
    expect(openWithVersion(PLAN_VERSION).document.body.withClass('card').length).toBeGreaterThan(10)
  })
})
