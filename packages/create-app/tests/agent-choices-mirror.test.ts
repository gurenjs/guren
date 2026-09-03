import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'

/**
 * AGENT_CHOICES in src/cli.ts mirrors AGENT_TARGETS in @guren/cli — a
 * cross-package literal this package cannot import (the CLI is installed into
 * the scaffolded app, and importing src/cli.ts would run its runMain side
 * effect). Both sources are read as text and pinned against each other.
 */

function extractList(source: string, constName: string, file: string): string[] {
  const match = source.match(new RegExp(`const ${constName} = \\[([^\\]]+)\\] as const`, 'u'))
  if (!match) {
    throw new Error(`Could not find the ${constName} literal in ${file}`)
  }
  return [...match[1]!.matchAll(/'([a-z]+)'/gu)].map((entry) => entry[1]!)
}

describe('AGENT_CHOICES mirror', () => {
  it('matches @guren/cli AGENT_TARGETS, and the prompt offers every choice', async () => {
    const createAppSource = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8')
    const cliSource = await readFile(
      new URL('../../cli/src/agent-targets.ts', import.meta.url),
      'utf8',
    )

    const choices = extractList(createAppSource, 'AGENT_CHOICES', 'packages/create-app/src/cli.ts')
    const targets = extractList(cliSource, 'AGENT_TARGETS', 'packages/cli/src/agent-targets.ts')
    expect(choices).toEqual(targets)

    // the interactive multiselect is a second mirror of the same list
    const optionValues = [...createAppSource.matchAll(/\{ value: '([a-z]+)', label:/gu)].map(
      (entry) => entry[1]!,
    )
    for (const choice of choices) {
      expect(optionValues).toContain(choice)
    }
  })
})
