import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  JUNIT_MAX_ATTRIBUTE_CHARS,
  JUNIT_MAX_CHARS,
  JUNIT_MAX_DEPTH,
  acceptanceStatus,
  planAcceptanceIds,
  type AcceptanceReport,
} from '../src/plan/acceptance-status'
import { PlanSchema } from '../src/plan/schema'
import { TEST_BASELINE, loadCommentsPlan } from './plan-fixture'

type ReadReport = Extract<AcceptanceReport, { state: 'read' }>

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, 'fixtures/plan/junit', name), 'utf8')
}

function read(junit: string, ids: readonly string[]): ReadReport {
  const report = acceptanceStatus(junit, ids)
  if (report.state !== 'read') throw new Error(`blocked: ${report.reason}`)
  return report
}

function statuses(report: ReadReport): Record<string, string> {
  return Object.fromEntries(report.behaviours.map((behaviour) => [behaviour.id, behaviour.status]))
}

function blockedReason(junit: string | undefined, ids: readonly string[] = ['AC-a-1']): string {
  const report = acceptanceStatus(junit, ids)
  if (report.state !== 'blocked') throw new Error('expected the report to be blocked')
  return report.reason
}

function suites(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test"><testsuite name="a.test.ts" file="a.test.ts">${body}</testsuite></testsuites>`
}

function testcase(name: string, inner = '', file = 'a.test.ts'): string {
  return `<testcase name="${name}" file="${file}">${inner}</testcase>`
}

const MAIN_IDS = [
  'AC-comments-1',
  'AC-comments-2',
  'AC-comments-3',
  'AC-comments-4',
  'AC-comments-5',
  'AC-comments-6',
  'AC-comments-7',
  'AC-comments-10',
  'AC-x-1',
  'AC-x-2',
  'AC-x-3',
  'AC-top-1',
  'AC-never-written',
]

// Written by the Bun named in the file; only `hostname` and the probe's directory were edited.
for (const name of ['bun-1.3.14.xml', 'bun-1.3.11.xml']) {
  describe(`acceptanceStatus on ${name}`, () => {
    const report = read(fixture(name), MAIN_IDS)
    const byId = new Map(report.behaviours.map((behaviour) => [behaviour.id, behaviour]))

    test('should match an id carried by a describe name for every case under it', () => {
      const titles = byId.get('AC-comments-1')?.cases.map((entry) => entry.title)
      expect(titles).toContain('comments > [AC-comments-1] store > creates a comment')
      expect(titles).toContain('comments > [AC-comments-1] store > [AC-comments-2] accepts 1')
    })

    test('should collect every test.each case under the one id', () => {
      expect(byId.get('AC-comments-2')?.cases).toHaveLength(2)
      expect(byId.get('AC-comments-2')?.status).toBe('passing')
    })

    test('should count a skipped case as failing', () => {
      expect(byId.get('AC-comments-3')?.cases[0]?.outcome).toBe('skipped')
      expect(byId.get('AC-comments-3')?.status).toBe('failing')
    })

    test('should count a todo case as failing', () => {
      expect(byId.get('AC-comments-4')?.status).toBe('failing')
    })

    test('should report a failed expectation as failing', () => {
      expect(byId.get('AC-comments-5')?.status).toBe('failing')
    })

    test('should report a thrown error as failing', () => {
      expect(byId.get('AC-comments-6')?.cases[0]?.outcome).toBe('failed')
    })

    test('should decode the escaped characters of a title', () => {
      const title = byId.get('AC-comments-7')?.cases[0]?.title ?? ''
      expect(title).toContain(`title with <tag> & "quotes" and 'apos' ]]>`)
      expect(title).toContain('é 日本語')
    })

    test('should count a case once when its title repeats the id', () => {
      expect(byId.get('AC-x-1')?.cases).toHaveLength(1)
    })

    test('should count a case naming two ids for both', () => {
      expect(byId.get('AC-x-2')?.status).toBe('passing')
      expect(byId.get('AC-x-3')?.status).toBe('passing')
      expect(byId.get('AC-x-2')?.cases[0]?.title).toBe(byId.get('AC-x-3')?.cases[0]?.title)
    })

    test('should keep AC-comments-1 out of [AC-comments-10]', () => {
      const titles = byId.get('AC-comments-1')?.cases.map((entry) => entry.title) ?? []
      expect(titles.some((title) => title.includes('ten'))).toBe(false)
      expect(byId.get('AC-comments-10')?.cases).toHaveLength(1)
    })

    test('should read a test outside any describe', () => {
      expect(byId.get('AC-top-1')?.cases[0]?.title).toBe('[AC-top-1] top level')
    })

    test('should leave a behaviour no test carries pending', () => {
      expect(byId.get('AC-never-written')).toEqual({ id: 'AC-never-written', status: 'pending', cases: [] })
    })

    test('should report an id carried by two test files', () => {
      expect(report.errors).toEqual([
        { kind: 'id-in-several-files', id: 'AC-comments-1', files: ['tests/probe-a.test.ts', 'tests/probe-b.test.ts'] },
      ])
    })

    test('should report an id no behaviour declares', () => {
      const narrowed = read(fixture(name), ['AC-comments-2'])
      const undeclared = narrowed.errors.filter((error) => error.kind === 'undeclared-id').map((error) => error.id)
      expect(undeclared).toContain('AC-top-1')
      expect(undeclared).toContain('AC-comments-10')
      expect(undeclared).not.toContain('AC-comments-2')
    })
  })
}

describe('acceptanceStatus on bun-1.3.14-edge.xml', () => {
  const ids = ['AC-c-1', 'AC-c-2', 'AC-c-3', 'AC-c-4', 'AC-c-5', 'AC-c-6']
  const report = read(fixture('bun-1.3.14-edge.xml'), ids)

  test('should judge each edge the way Bun reported it', () => {
    expect(statuses(report)).toEqual({
      'AC-c-1': 'failing', // describe.skip
      'AC-c-2': 'passing', // test.failing that failed as expected
      'AC-c-3': 'failing', // test.if(false)
      'AC-c-4': 'pending', // behind a throwing beforeAll: Bun reports "(unnamed)" and drops the test
      'AC-c-5': 'failing', // rejected promise
      'AC-c-6': 'passing', // newline and tab in the title
    })
    expect(report.errors).toEqual([])
  })
})

describe('acceptanceStatus rules', () => {
  test('should call a case with time="0" and no <skipped> executed', () => {
    const junit = suites('<testcase name="[AC-a-1] fast" time="0" file="a.test.ts" />')
    expect(statuses(read(junit, ['AC-a-1']))).toEqual({ 'AC-a-1': 'passing' })
  })

  test('should fail a behaviour when one of its cases fails', () => {
    const junit = suites(testcase('[AC-a-1] one') + testcase('[AC-a-1] two', '<failure type="AssertionError" />'))
    expect(statuses(read(junit, ['AC-a-1']))).toEqual({ 'AC-a-1': 'failing' })
  })

  test('should read an <error> child as a failed case', () => {
    const junit = suites(testcase('[AC-a-1] one', '<error message="boom">trace</error>'))
    expect(statuses(read(junit, ['AC-a-1']))).toEqual({ 'AC-a-1': 'failing' })
  })

  test('should match an id holding a dot literally', () => {
    const junit = suites(testcase('[AC-aXb-1] other'))
    const report = read(junit, ['AC-a.b-1'])
    expect(statuses(report)).toEqual({ 'AC-a.b-1': 'pending' })
    expect(report.errors.map((error) => error.id)).toEqual(['AC-aXb-1'])
  })

  test('should match an id inside doubled brackets', () => {
    expect(statuses(read(suites(testcase('[[AC-a-1]] x')), ['AC-a-1']))).toEqual({ 'AC-a-1': 'passing' })
  })

  test('should not match an id without its brackets', () => {
    expect(statuses(read(suites(testcase('AC-a-1 bare, [AC-a-1 open')), ['AC-a-1']))).toEqual({ 'AC-a-1': 'pending' })
  })

  test('should not take the file name for part of the title', () => {
    const junit = `<testsuites><testsuite name="[AC-a-1].test.ts" file="x"><testcase name="t" file="x" /></testsuite></testsuites>`
    expect(statuses(read(junit, ['AC-a-1']))).toEqual({ 'AC-a-1': 'pending' })
  })

  test('should not take classname for part of the title', () => {
    const junit = suites('<testcase name="t" classname="[AC-a-1] store" file="a.test.ts" />')
    expect(statuses(read(junit, ['AC-a-1']))).toEqual({ 'AC-a-1': 'pending' })
  })

  test('should leave a bracketed word outside the AC- prefix alone', () => {
    expect(read(suites(testcase('[GET] /posts [admin] [1, 2]')), ['AC-a-1']).errors).toEqual([])
  })

  test('should stay linear on a title of open brackets', () => {
    const title = '['.repeat(JUNIT_MAX_ATTRIBUTE_CHARS - 16) + '[AC-a-1]'
    const started = performance.now()
    expect(statuses(read(suites(testcase(title)), ['AC-a-1']))).toEqual({ 'AC-a-1': 'passing' })
    expect(performance.now() - started).toBeLessThan(2000)
  })

  test('should read CDATA, comments and numeric references', () => {
    const junit = suites(
      `<!-- note --><testcase name="&#91;AC-a-1&#x5D; x" file="a.test.ts"><system-out><![CDATA[</testcase> <oops>]]></system-out></testcase>`,
    )
    expect(statuses(read(junit, ['AC-a-1']))).toEqual({ 'AC-a-1': 'passing' })
  })

  test('should collect the acceptance ids of a plan', () => {
    const plan = PlanSchema.parse({ ...loadCommentsPlan(), baseline: TEST_BASELINE })
    const ids = planAcceptanceIds(plan)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids).toEqual(plan.tasks.flatMap((task) => task.acceptance.map((behaviour) => behaviour.id)))
  })
})

describe('acceptanceStatus blocked', () => {
  test('should block when no report was written', () => {
    expect(blockedReason(undefined)).toContain('no junit report')
  })

  test('should block on an empty report', () => {
    expect(blockedReason('')).toContain('no element')
  })

  test('should block on a truncated file', () => {
    const whole = fixture('bun-1.3.14.xml')
    expect(blockedReason(whole.slice(0, whole.length / 2))).toContain('the report ends inside')
  })

  test('should block on a file that ends before its closing tags', () => {
    const junit = '<testsuites><testsuite name="a" file="a"><testcase name="[AC-a-1] x" file="a" />'
    expect(blockedReason(junit)).toContain('ends inside <testsuite>')
  })

  test('should block on a file truncated inside an attribute', () => {
    expect(blockedReason('<testsuites><testsuite name="a')).toContain('ends inside an attribute')
  })

  test('should block on mismatched tags', () => {
    expect(blockedReason('<testsuites><testsuite name="a" file="a"></testsuites></testsuite>')).toContain('closes <testsuite>')
  })

  test('should block on an unknown entity', () => {
    expect(blockedReason(suites(testcase('[AC-a-1] &nbsp;')))).toContain('&nbsp;')
  })

  test('should block on a reference to a surrogate', () => {
    expect(blockedReason(suites(testcase('[AC-a-1] &#xD800;')))).toContain('unknown entity')
  })

  test('should block on a DOCTYPE', () => {
    const junit = `<!DOCTYPE x [<!ENTITY a "aaaa">]>${suites(testcase('[AC-a-1] &a;'))}`
    expect(blockedReason(junit)).toContain('declaration')
  })

  test('should block on a 10 MB title', () => {
    const junit = suites(testcase(`[AC-a-1] ${'x'.repeat(10 * 1024 * 1024)}`))
    expect(blockedReason(junit)).toContain(`over ${JUNIT_MAX_ATTRIBUTE_CHARS} characters`)
  })

  test('should block on a report over the size cap', () => {
    expect(blockedReason(suites('') + ' '.repeat(JUNIT_MAX_CHARS))).toContain(`over ${JUNIT_MAX_CHARS} characters`)
  })

  test('should block on deep nesting', () => {
    const depth = JUNIT_MAX_DEPTH + 40
    const junit = `<testsuites>${'<testsuite name="d" file="a">'.repeat(depth)}${'</testsuite>'.repeat(depth)}</testsuites>`
    expect(blockedReason(junit)).toContain('nest deeper')
  })

  test('should block on a root that is not <testsuites>', () => {
    expect(blockedReason('<html />')).toContain('<html>')
  })

  test('should block on an element the format does not have', () => {
    expect(blockedReason(suites(testcase('[AC-a-1] x', '<flaky />')))).toContain('<flaky>')
  })

  test('should keep an oversized element name out of the reason', () => {
    expect(blockedReason(`<${'a'.repeat(100_000)} />`).length).toBeLessThan(400)
  })

  test('should block on a testcase with no file', () => {
    expect(blockedReason(suites('<testcase name="[AC-a-1] x" />'))).toContain('no file attribute')
  })

  test('should block on a repeated attribute', () => {
    expect(blockedReason(suites('<testcase name="a" name="[AC-a-1]" file="f" />'))).toContain('repeats')
  })

  test('should block on text after the root', () => {
    expect(blockedReason(`${suites('')}trailing`)).toContain('outside the root')
  })

  test('should block on a second root', () => {
    expect(blockedReason(`${suites('')}<testsuites />`)).toContain('second root')
  })
})

/**
 * CI runs more than one Bun, and the committed reports come from the ones a developer
 * machine had. This one is written by whichever Bun runs the suite.
 */
describe('acceptanceStatus on a report written by the running Bun', () => {
  const PROBE = `import { describe, expect, test } from 'bun:test'
describe('outer', () => {
  describe('[AC-live-1] inner', () => {
    test('passes', () => {})
    test.each([1, 2])('[AC-live-2] each %d', () => {})
  })
  test.skip('[AC-live-3] skipped', () => {})
  test.todo('[AC-live-4] todo')
  test('[AC-live-5] fails', () => { expect(1).toBe(2) })
  test('[AC-live-6] throws <&> "q"', () => { throw new Error('boom') })
})
`

  test(
    'should read every rule out of it',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'guren-plan-junit-'))
      try {
        await writeFile(join(dir, 'probe.test.ts'), PROBE, 'utf8')
        const outfile = join(dir, 'junit.xml')
        const child = Bun.spawn(
          [process.execPath, 'test', './probe.test.ts', '--reporter=junit', `--reporter-outfile=${outfile}`],
          { cwd: dir, stdout: 'ignore', stderr: 'ignore', stdin: 'ignore', timeout: 60_000 },
        )
        await child.exited

        const ids = ['AC-live-1', 'AC-live-2', 'AC-live-3', 'AC-live-4', 'AC-live-5', 'AC-live-6', 'AC-live-7']
        const report = read(await readFile(outfile, 'utf8'), ids)
        expect(statuses(report)).toEqual({
          'AC-live-1': 'passing',
          'AC-live-2': 'passing',
          'AC-live-3': 'failing',
          'AC-live-4': 'failing',
          'AC-live-5': 'failing',
          'AC-live-6': 'failing',
          'AC-live-7': 'pending',
        })
        expect(report.behaviours[0]?.cases.map((entry) => entry.title)).toContain('outer > [AC-live-1] inner > passes')
        expect(report.behaviours[1]?.cases).toHaveLength(2)
        expect(report.behaviours[5]?.cases[0]?.title).toBe('outer > [AC-live-6] throws <&> "q"')
        expect(report.errors).toEqual([])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    90_000,
  )
})
