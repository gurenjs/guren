import { expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FIELD_LABEL_CLASS, FORM_INPUT_CLASS, PRIMARY_BUTTON_CLASS } from '../src/guren-css'

const cliRoot = join(import.meta.dir, '..')

const readRule = () => readFile(join(cliRoot, 'templates/agent/core/rules/ui.md'), 'utf8')
const readTokens = () => readFile(join(cliRoot, 'templates/scaffold/guren-ui/resources/css/guren.css'), 'utf8')

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`)
  expect(start).toBeGreaterThan(-1)
  const end = markdown.indexOf('\n## ', start + 1)
  return markdown.slice(start, end === -1 ? undefined : end)
}

it('the ui rule carries the generators’ shared class strings verbatim', async () => {
  const rule = await readRule()
  for (const classes of [FORM_INPUT_CLASS, FIELD_LABEL_CLASS, PRIMARY_BUTTON_CLASS]) {
    expect(rule).toContain(`\`${classes}\``)
  }
})

it('every token the ui rule lists is declared in guren.css', async () => {
  const [rule, tokens] = await Promise.all([readRule(), readTokens()])
  const declared = [...new Set([...tokens.matchAll(/--(g-[\w-]+):/g)].map((match) => match[1]))]
  // The second column of the token table names tokens without `--g-`; `-chip` and `-tint` are suffixes.
  const names = [...section(rule, 'The tokens').matchAll(/^\| [^|]+ \| ([^|]+) \|/gm)]
    .slice(1)
    .flatMap((row) => [...row[1]!.matchAll(/`([\w-]+)`/g)].map((match) => match[1]!))
    .filter((name) => !name.startsWith('-'))
  expect(names.length).toBeGreaterThan(20)
  for (const name of names) expect(declared).toContain(`g-${name}`)
})

it('every g- utility the ui rule names is mapped in guren.css', async () => {
  const [rule, tokens] = await Promise.all([readRule(), readTokens()])
  const mapped = [...new Set([...tokens.matchAll(/--(?:color|radius|shadow)-(g-[\w-]+):/g)].map((match) => match[1]))]
  const utilities = [...rule.matchAll(/\b(?:bg|text|border|outline|accent|rounded|shadow)-(g-[\w-]+)/g)].map(
    (match) => match[1]!,
  )
  expect(utilities.length).toBeGreaterThan(10)
  for (const utility of utilities) expect(mapped).toContain(utility)
})
