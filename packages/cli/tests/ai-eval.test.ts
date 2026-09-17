import { afterEach, describe, expect, test } from 'bun:test'

import { parseNumericArg, runAiEval, type EvalRunnerModule, type EvalRunResultLike } from '../src/ai-eval'
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from './helpers'

let workspace: TempWorkspace | undefined
afterEach(async () => {
  await workspace?.cleanup()
  workspace = undefined
})

const DEFINITION = { kind: 'guren.eval' }

function stubRunner(overrides: Partial<EvalRunResultLike> = {}): EvalRunnerModule & { calls: Array<{ definition: unknown; options: Record<string, unknown> }> } {
  const calls: Array<{ definition: unknown; options: Record<string, unknown> }> = []
  return {
    calls,
    runEval: async (definition, options) => {
      calls.push({ definition, options })
      return {
        summary: {
          flow: 'triage', variant: 'baseline', cases: 2, reps: 1, rows: 2,
          truncated: 0, failures: 0, metrics: [{ id: 'ok', kind: 'binary', mean: 1, n: 2, halfWidth: 0.7 }],
          costUsd: 0.5, durationMs: 1200,
        },
        failures: [],
        location: '/tmp/hillclimb/triage/baseline',
        plannedCases: [{ id: 'a' }, { id: 'b' }],
        ...overrides,
      }
    },
    formatSummary: (summary) => `summary for ${summary.flow}/${summary.variant}`,
  }
}

async function seedEval(contents = 'export default { kind: "guren.eval" }\n', path = 'tests/evals/triage.eval.ts'): Promise<TempWorkspace> {
  workspace = await createTempWorkspace('guren-ai-eval-')
  await writeWorkspaceFiles(workspace.dir, { [path]: contents })
  return workspace
}

describe('runAiEval', () => {
  test('should resolve tests/evals/<flow>.eval.ts and pass the flag values through', async () => {
    await seedEval()
    const runner = stubRunner()
    const lines: string[] = []

    await runAiEval(
      { flow: 'triage', variant: 'v1', reps: 2, cases: 20, maxCostUsd: 5, concurrency: 3 },
      { loadDefinition: async () => DEFINITION, loadRunner: async () => runner, print: (line) => lines.push(line) },
    )

    expect(runner.calls[0]!.definition).toBe(DEFINITION)
    expect(runner.calls[0]!.options).toMatchObject({
      flow: 'triage', variant: 'v1', reps: 2, cases: 20, maxCostUsd: 5, concurrency: 3,
    })
    expect(lines[0]).toBe('summary for triage/baseline')
  })

  test('should leave an unset flag out rather than pass undefined, so the runner keeps its own default', async () => {
    await seedEval()
    const runner = stubRunner()

    await runAiEval({ flow: 'triage' }, { loadDefinition: async () => DEFINITION, loadRunner: async () => runner, print: () => {} })

    const options = runner.calls[0]!.options
    expect(Object.hasOwn(options, 'variant')).toBe(false)
    expect(Object.hasOwn(options, 'reps')).toBe(false)
    expect(Object.hasOwn(options, 'maxCostUsd')).toBe(false)
  })

  test('should print where results landed and who reads that layout, rather than shipping a viewer', async () => {
    await seedEval()
    const lines: string[] = []

    await runAiEval(
      { flow: 'triage' },
      { loadDefinition: async () => DEFINITION, loadRunner: async () => stubRunner(), print: (line) => lines.push(line) },
    )

    expect(lines.join('\n')).toContain('Results: /tmp/hillclimb/triage/baseline')
    expect(lines.join('\n')).toContain('hillclimb')
    expect(lines.join('\n')).toContain('Guren ships no viewer')
  })

  test('should report a dry run as a plan, not as a summary', async () => {
    await seedEval()
    const lines: string[] = []

    await runAiEval(
      { flow: 'triage', dryRun: true },
      { loadDefinition: async () => DEFINITION, loadRunner: async () => stubRunner(), print: (line) => lines.push(line) },
    )

    expect(lines[0]).toContain('2 case(s) would run')
    expect(lines.join('\n')).not.toContain('summary for')
  })

  test('should emit the summary and location as JSON', async () => {
    await seedEval()
    const lines: string[] = []

    await runAiEval(
      { flow: 'triage', json: true },
      { loadDefinition: async () => DEFINITION, loadRunner: async () => stubRunner(), print: (line) => lines.push(line) },
    )

    const emitted = JSON.parse(lines[0]!) as { summary: { flow: string }; location: string; cases: number }
    expect(emitted).toMatchObject({ location: '/tmp/hillclimb/triage/baseline', cases: 2 })
    expect(emitted.summary.flow).toBe('triage')
  })

  test('should accept --file and --dir instead of the default location', async () => {
    workspace = await createTempWorkspace('guren-ai-eval-')
    await writeWorkspaceFiles(workspace.dir, {
      'evals/triage.eval.ts': 'export default {}\n',
      'elsewhere/custom.ts': 'export default {}\n',
    })
    const loaded: string[] = []
    const dependencies = {
      loadDefinition: async (path: string) => { loaded.push(path); return DEFINITION },
      loadRunner: async () => stubRunner(),
      print: () => {},
    }

    await runAiEval({ flow: 'triage', dir: 'evals' }, dependencies)
    await runAiEval({ flow: 'triage', file: 'elsewhere/custom.ts' }, dependencies)

    expect(loaded[0]!.endsWith('evals/triage.eval.ts')).toBe(true)
    expect(loaded[1]!.endsWith('elsewhere/custom.ts')).toBe(true)
  })

  test('should name where it looked when no eval file matches the flow', async () => {
    workspace = await createTempWorkspace('guren-ai-eval-')

    await expect(
      runAiEval({ flow: 'triage' }, { loadRunner: async () => stubRunner(), print: () => {} }),
    ).rejects.toThrow('No eval named "triage"')
    await expect(
      runAiEval({ flow: 'triage', file: 'nope.ts' }, { loadRunner: async () => stubRunner(), print: () => {} }),
    ).rejects.toThrow('--file nope.ts does not exist')
  })

  test('should refuse a file whose default export is not a defineEval() result', async () => {
    await seedEval()

    await expect(
      runAiEval(
        { flow: 'triage' },
        { loadDefinition: async () => ({ agent: 'SupportTriager' }), loadRunner: async () => stubRunner(), print: () => {} },
      ),
    ).rejects.toThrow('does not default-export a defineEval() result')
  })

  test('should point at guren add ai when the plugin\'s eval subpath cannot be imported', async () => {
    await seedEval()

    await expect(
      runAiEval(
        { flow: 'triage' },
        {
          loadDefinition: async () => DEFINITION,
          loadRunner: async () => { throw new Error('Cannot find module') },
          print: () => {},
        },
      ),
    ).rejects.toThrow('guren add ai')
  })

  test('should import the eval file for real when no loader is injected', async () => {
    await seedEval('export default { kind: "guren.eval", marker: 42 }\n')
    const runner = stubRunner()

    await runAiEval({ flow: 'triage' }, { loadRunner: async () => runner, print: () => {} })

    expect(runner.calls[0]!.definition).toMatchObject({ marker: 42 })
  })
})

describe('parseNumericArg', () => {
  test('should read a positive number and name the flag on anything else', () => {
    expect(parseNumericArg('reps', '2')).toBe(2)
    expect(parseNumericArg('max-cost-usd', '0.5')).toBe(0.5)
    expect(parseNumericArg('reps', undefined)).toBeUndefined()
    expect(parseNumericArg('reps', '')).toBeUndefined()
    expect(() => parseNumericArg('reps', 'two')).toThrow('--reps must be a positive number, got "two"')
    expect(() => parseNumericArg('cases', '0')).toThrow('--cases must be a positive number')
  })
})
