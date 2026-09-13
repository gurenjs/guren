import { describe, expect, it } from 'bun:test'

import { builtinSubCommands } from '../src/commands'
import { closestCommandNames, unknownCommandHint } from '../src/unknown-command'

const builtins = Object.keys(builtinSubCommands)

describe('closestCommandNames', () => {
  it('suggests a builtin that shares the namespace and the action', () => {
    expect(closestCommandNames('db:migrate:status', builtins)).toContain('db:status')
  })

  it('ranks a one-letter typo first', () => {
    expect(closestCommandNames('make:controler', builtins)[0]).toBe('make:controller')
  })

  it('suggests nothing for a name unlike any command', () => {
    expect(closestCommandNames('definitely-not-a-command', builtins)).toEqual([])
    expect(closestCommandNames('attachments:prune', builtins)).toEqual([])
  })

  it('returns at most the limit', () => {
    expect(closestCommandNames('make:', builtins).length).toBeLessThanOrEqual(3)
  })
})

describe('unknownCommandHint', () => {
  it('points a namespaced name at the app console runner and away from the REPL', () => {
    const hint = unknownCommandHint('attachments:prune', builtins, true)

    expect(hint).toContain('bun run console attachments:prune')
    expect(hint).toContain('`bunx guren console` opens a REPL')
    expect(hint).not.toContain('Did you mean')
  })

  it('suggests a close name and still mentions the console runner for a namespaced typo', () => {
    const hint = unknownCommandHint('db:migrate:status', builtins, true)

    expect(hint).toContain('`db:status`')
    expect(hint).toContain('bun run console db:migrate:status')
  })

  it('leaves the console runner out below the root and for a bare name', () => {
    expect(unknownCommandHint('attachmentz', ['attachments', 'auth'], false)).toBe('Did you mean `attachments`?')
    expect(unknownCommandHint('storage:linky', ['attachments', 'auth'], false)).toBeUndefined()
    expect(unknownCommandHint('definitely-not-a-command', builtins, true)).toBeUndefined()
  })
})
