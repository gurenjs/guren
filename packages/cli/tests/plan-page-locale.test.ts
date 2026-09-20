import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadPlanDictionaries } from '../src/plan/locales'
import { planTemplateSource, renderPlanHtml, type RenderPlanInput } from '../src/plan/render'
import { planPageData } from './plan-fixture'
import { openPlanPage, openPlanPageWith, pageSentences, planPageSource, type Page, type PageNode, type PageOptions } from './plan-page-dom'
import { RICH_CHECKS, richPlan } from './plan-page-rich'

const LOCALE_KEY = 'guren.plan.locale'

function open(input: Partial<RenderPlanInput> = {}, options?: PageOptions): Page {
  return openPlanPage(renderPlanHtml({ plan: richPlan(), checks: RICH_CHECKS, planFile: 'comments.plan.json', ...input }), options)
}

const notTheSwitch = (node: PageNode): boolean => node.id === 'locale-switch'

function switchTo(page: Page, locale: string): void {
  const select = page.byId('locale-select')
  select.value = locale
  select.dispatch('change')
}

function sentenceOf(page: Page, acceptanceId: string, label: string): PageNode {
  const labels = page.byId(`el-${acceptanceId}`).withClass('label')
  const at = labels.findIndex((node) => node.textContent === label)
  if (at < 0) throw new Error(`${acceptanceId} has no ${label} row`)
  const row = labels[at]!.parentNode!
  return row.childNodes[row.childNodes.indexOf(labels[at]!) + 1]!
}

describe('the plan page in en', () => {
  // Captured from the page before any of its words went through a dictionary.
  const before = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/plan/rich-page.en.json'), 'utf8')) as string[]

  test('should say and link what it did before it was localised', () => {
    expect(pageSentences(open().document.body, notTheSwitch)).toEqual(before)
  })

  test('should say the same again after a round trip through ja', () => {
    const page = open()

    switchTo(page, 'ja')
    switchTo(page, 'en')

    expect(pageSentences(page.document.body, notTheSwitch)).toEqual(before)
  })
})

describe('the plan page in ja', () => {
  test('should put the actor and the route where Japanese puts them, with the route still a link', () => {
    const page = open({ uiLocale: 'ja' })

    const when = sentenceOf(page, 'AC-comments-page', '操作')

    expect(when.textContent).toBe('guest が route.comments.index を呼ぶ')
    expect(when.withTag('a').map((link) => link.href)).toEqual(['#el-route.comments.index'])
  })

  test('should keep the input between the actor and the route', () => {
    const when = sentenceOf(open({ uiLocale: 'ja' }), 'AC-comments-1', '操作')

    expect(when.textContent).toBe('user が body = "Nice post" を付けて route.comments.store を呼ぶ')
  })

  test('should word the expectations and keep the page a link', () => {
    const then = sentenceOf(open({ uiLocale: 'ja' }), 'AC-comments-page', '結果')

    expect(then.textContent).toBe('ステータス 200view.posts.show を描画')
    expect(then.withTag('a').map((link) => link.href)).toEqual(['#el-view.posts.show'])
  })

  test('should link every element en links, in whatever order the sentences need', () => {
    const targets = (page: Page): string[] =>
      page.document.body
        .withTag('a')
        .map((link) => link.href)
        .sort()

    expect(targets(open({ uiLocale: 'ja' }))).toEqual(targets(open()))
  })

  test('should leave no English sentence frame on the page', () => {
    const said = pageSentences(open({ uiLocale: 'ja' }).document.body).join('\n')

    for (const frame of [' calls ', 'validated by', 'Referenced by', 'Needs attention', 'Breaking:', 'elements shown', 'renders ']) {
      expect(said).not.toContain(frame)
    }
  })

  test('should never translate a check result or the column fact line', () => {
    const page = open({ uiLocale: 'ja' })

    expect(page.byId('pinned').textContent).toContain('fail Route action')
    expect(page.byId('pinned').textContent).toContain('The action is not declared.')
    expect(page.byId('el-column.comment.postId').withClass('facts')[0]!.textContent).toBe(
      'integer  idx  as post_id  references model.post.id on delete cascade',
    )
  })

  test('should say a breaking reason in ja from the key, not from the English sentence', () => {
    const page = open({ uiLocale: 'ja' })

    expect(page.byId('pinned').textContent).toContain('articles から改名します。')
    expect(page.byId('pinned').textContent).not.toContain('Renamed from')
  })
})

describe('the languages of the plan page', () => {
  test('should give the document the language of the plan, whatever the page speaks', () => {
    const page = open({ uiLocale: 'ja' })

    expect(page.document.documentElement.getAttribute('lang')).toBe('en')
  })

  test('should give a ja plan read in en a ja document', () => {
    const page = open({ plan: richPlan('ja-JP'), uiLocale: 'en' })

    expect(page.document.documentElement.getAttribute('lang')).toBe('ja-JP')
    expect(page.byId('tabs').getAttribute('lang')).toBe('en')
  })

  test.each(['tabs', 'controls', 'footer'])('should mark #%s with the language the page speaks', (id) => {
    const page = open({ uiLocale: 'ja' })

    expect(page.byId(id).getAttribute('lang')).toBe('ja')
    switchTo(page, 'en')
    expect(page.byId(id).getAttribute('lang')).toBe('en')
  })

  test('should mark the review controls of a card', () => {
    const card = open({ uiLocale: 'ja' }).byId('el-model.post')

    expect(card.withClass('mark')[0]!.getAttribute('lang')).toBe('ja')
    expect(card.withClass('review')[0]!.getAttribute('lang')).toBe('ja')
  })

  test('should name a panel by a heading in the language the page speaks, not by a label in the plan\'s', () => {
    const page = open({ uiLocale: 'ja' })
    const panel = page.byId('panel-routes')
    const heading = page.byId(panel.getAttribute('aria-labelledby')!)

    expect(panel.getAttribute('aria-label')).toBeNull()
    expect(panel.getAttribute('lang')).toBeNull()
    expect([heading.textContent, heading.getAttribute('lang')]).toEqual(['ルート', 'ja'])
  })

  test('should leave plan prose in the document language', () => {
    const page = open({ uiLocale: 'ja' })

    expect(page.byId('plan-summary').getAttribute('lang')).toBeNull()
    expect(page.byId('plan-title').getAttribute('lang')).toBeNull()
  })
})

describe('the initial locale', () => {
  const initial = (input: Partial<RenderPlanInput>): string =>
    planPageData(renderPlanHtml({ plan: richPlan(), ...input })).i18n.initial

  test('should follow the language of the plan', () => {
    expect(initial({ plan: richPlan('ja-JP') })).toBe('ja')
    expect(initial({ plan: richPlan('en-GB') })).toBe('en')
  })

  test('should let the caller override the plan', () => {
    expect(initial({ plan: richPlan('ja'), uiLocale: 'en' })).toBe('en')
  })

  test('should fall back to en for a language with no dictionary', () => {
    expect(initial({ plan: richPlan('fr') })).toBe('en')
  })

  test('should embed every dictionary, so the page can switch with no request', () => {
    expect(planPageData(renderPlanHtml({ plan: richPlan() })).i18n.dictionaries).toEqual(loadPlanDictionaries())
  })
})

describe('switching the locale', () => {
  test('should offer each language under its own name', () => {
    const options = open().byId('locale-select').withTag('option')

    expect(options.map((option) => [option.value, option.textContent, option.getAttribute('lang')])).toEqual([
      ['en', 'English', 'en'],
      ['ja', '日本語', 'ja'],
    ])
  })

  test('should keep the open tab, the filter, the hash, the review and the answers', () => {
    const page = open({}, { hash: '#el-route.comments.index' })
    const routesTab = page.byId('tabs').childNodes[3]!
    routesTab.click()
    const filter = page.byId('entity-filter')
    filter.value = 'Comment'
    filter.dispatch('change')
    const card = page.byId('el-model.comment')
    card.withClass('approve')[0]!.click()
    const answer = page.byId('el-Q-delete').withTag('textarea')[0]!
    answer.value = 'Soft delete.'
    answer.dispatch('input')
    const shownBefore = page.document.body.withClass('card').map((node) => node.shown)

    switchTo(page, 'ja')

    expect(routesTab.getAttribute('aria-selected')).toBe('true')
    expect(routesTab.textContent).toBe('ルート (4)')
    expect(page.byId('panel-routes').hidden).toBe(false)
    expect(filter.value).toBe('Comment')
    expect(page.location.hash).toBe('#el-route.comments.index')
    expect(page.document.body.withClass('card').map((node) => node.shown)).toEqual(shownBefore)
    expect(card.withClass('mark')[0]!.textContent).toBe('承認済み')
    expect(card.withClass('approve')[0]!.getAttribute('aria-pressed')).toBe('true')
    expect(answer.value).toBe('Soft delete.')
    expect(page.byId('el-Q-delete').withClass('badge-alter')[0]!.hidden).toBe(true)
    expect(page.byId('visible-count').textContent).toMatch(/^\d+ 件中 \d+ 件を表示$/)
  })

  test('should remember the choice under a key that is not the plan hash', () => {
    const page = open()

    switchTo(page, 'ja')

    expect(page.storage[LOCALE_KEY]).toBe('ja')
    expect(Object.keys(page.storage).filter((key) => key.includes(planPageData(renderPlanHtml({ plan: richPlan() })).planHash!))).toEqual(
      [],
    )
  })

  test('should open in the remembered locale over the rendered one', () => {
    const page = open({ uiLocale: 'en' }, { storage: { [LOCALE_KEY]: 'ja' } })

    expect(page.byId('copy').textContent).toBe('フィードバックをコピー')
    expect(page.byId('locale-select').value).toBe('ja')
  })

  test.each(['fr', 'constructor', '__proto__', ''])('should ignore a remembered %p', (stored) => {
    const page = open({ uiLocale: 'en' }, { storage: { [LOCALE_KEY]: stored } })

    expect(page.byId('copy').textContent).toBe('Copy feedback')
  })

  test('should redraw the diagram in the new locale without losing what was expanded', () => {
    const page = open()
    const table = (): PageNode => page.byId('panel-models').withClass('table')[0]!
    table().click()

    switchTo(page, 'ja')

    expect(table().getAttribute('aria-expanded')).toBe('true')
    expect(page.byId('panel-models').withTag('svg')[0]!.getAttribute('aria-label')).toBe('プランの ER 図')
  })
})

describe('the plan page source', () => {
  const source = planTemplateSource()

  test('should hide the locale switch in print with the rest of the controls', () => {
    const print = source.slice(source.indexOf('@media print'))

    expect(source).toContain('<label class="locale-switch" id="locale-switch" hidden>')
    expect(source.indexOf('id="locale-switch"')).toBeGreaterThan(source.indexOf('<div class="controls" id="controls">'))
    expect(print).toMatch(/\.controls,[\s\S]*?display: none !important/)
  })

  test('should take a template from the shipped dictionaries and from nowhere else', () => {
    // `phrase()` is the one reader of a dictionary; the third call is `formatText` handing on its own argument.
    const calls = planPageSource()
      .split('\n')
      .filter((line) => /format(Into|Text)\(/.test(line) && !line.includes('function '))
      .map((line) => line.trim())

    expect(calls).toEqual([
      "return formatInto(el('span'), template, values).textContent",
      'return formatText(phrase(key), resolve(values))',
      'formatInto(node, phrase(key), resolve(values))',
    ])
  })

  test('should write a plan string that spells a placeholder as text', () => {
    const plan = richPlan()
    plan.tasks[0]!.acceptance[0]!.actor = '{route}'

    const when = sentenceOf(open({ plan }), 'AC-comments-1', 'When')

    expect(when.textContent).toBe('a {route} calls route.comments.store with body = "Nice post"')
  })

  test('should spell out a key no dictionary has', () => {
    const page = openPlanPageWith(renderPlanHtml({ plan: richPlan() }), (data) => {
      delete (data.i18n.dictionaries.en as Record<string, string>)['footer.copy']
      delete (data.i18n.dictionaries.ja as Record<string, string>)['footer.copy']
    })

    expect(page.byId('copy').textContent).toBe('{footer.copy}')
  })

  test('should fall back to en for a key only ja lacks', () => {
    const page = openPlanPageWith(renderPlanHtml({ plan: richPlan(), uiLocale: 'ja' }), (data) => {
      delete (data.i18n.dictionaries.ja as Record<string, string>)['footer.copy']
    })

    expect(page.byId('copy').textContent).toBe('Copy feedback')
  })
})
