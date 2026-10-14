import { describe, expect, it } from 'vitest'
import { judgeDevOnlyInputs } from '../../scripts/lib/dev-only-inputs.js'

const collector = { what: 'the collector', files: ['/repo/packages/server/dist/runtime-errors-abc.js'] }
const cli = { what: 'the CLI', files: ['/repo/packages/cli/'] }

describe('judgeDevOnlyInputs', () => {
  it('passes a bundle that takes none of the files', () => {
    const verdict = judgeDevOnlyInputs(['/repo/packages/server/dist/index.js', '/repo/web/stubs/guren-cli.js'], [collector, cli])
    expect(verdict.ok).toBe(true)
  })

  it('names an exact file the bundle took', () => {
    const verdict = judgeDevOnlyInputs(['/repo/packages/server/dist/runtime-errors-abc.js'], [collector])
    expect(verdict.ok).toBe(false)
    expect(verdict.lines.join('\n')).toContain('runtime-errors-abc.js')
  })

  it('matches a directory prefix', () => {
    const verdict = judgeDevOnlyInputs(['/repo/packages/cli/dist/index.js'], [cli])
    expect(verdict.ok).toBe(false)
  })

  it('does not match a sibling that only shares the prefix text', () => {
    const verdict = judgeDevOnlyInputs(['/repo/packages/cli-extra/index.js'], [cli])
    expect(verdict.ok).toBe(true)
  })

  it('fails a group with no files rather than passing it', () => {
    const verdict = judgeDevOnlyInputs([], [{ what: 'the collector', files: [] }])
    expect(verdict.ok).toBe(false)
    expect(verdict.lines[0]).toContain('nothing to compare against')
  })
})
