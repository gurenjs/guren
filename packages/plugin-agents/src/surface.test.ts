import { describe, test, expect } from 'bun:test'

import * as root from './index'
import * as runtime from './runtime'

/**
 * Which names live on which entry (RFC 0017 §4).
 *
 * The seam is on `@guren/plugin-agents/runtime`, not the root, so `make:agent`'s
 * arch rule can name the subpath and agent code reaching for it fails
 * `guren check --arch`. A discipline, not a sandbox: it buys visibility.
 */
const SEAM = [
  'configureAgentRuntime',
  'resolveAgentRuntime',
  'resetAgentRuntime',
  'createAgentToolClient',
] as const

describe('the package entry points', () => {
  for (const name of SEAM) {
    test(`root does not export ${name}`, () => {
      expect(name in root).toBe(false)
    })

    test(`runtime exports ${name}`, () => {
      expect(typeof (runtime as Record<string, unknown>)[name]).toBe('function')
    })
  }

  test('root keeps the configuration surface an app needs', () => {
    // What `src/app.ts` and `config/agents.ts` import, on Bun.
    expect(typeof root.defineAgentsConfig).toBe('function')
    expect(typeof root.validateAgentsConfig).toBe('function')
    expect(typeof root.agentsPlugin).toBe('function')
  })
})
