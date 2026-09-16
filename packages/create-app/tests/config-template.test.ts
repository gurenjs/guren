import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../../..')
const TEMPLATES: string[] = ['default', 'api-only']

function templateFile(template: string, file: string): string {
  return join(repoRoot, 'packages/create-app/templates', template, file)
}

/** The keys a dotenv file assigns, as Bun reads it; a `# KEY=` line assigns nothing. */
function assignedKeys(content: string): string[] {
  return [...content.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gmu)].map((match) => match[1]!)
}

describe('scaffolded config/ (RFC 0027 §1, §2)', () => {
  // One environment and one host-authorization rule in two places: an api-only
  // app silently losing a check the default template kept is the drift here.
  test.each(['config/env.ts', 'config/http.ts'])('%s is identical in both starter templates', async (file) => {
    const [defaultCopy, apiCopy] = await Promise.all(TEMPLATES.map((name) => readFile(templateFile(name, file), 'utf8')))

    expect(apiCopy).toBe(defaultCopy)
  })

  test.each(TEMPLATES)('%s hands createApp() the schema and the definitions', async (template) => {
    const entry = await readFile(templateFile(template, 'src/app.ts'), 'utf8')

    expect(entry).toContain("import env from '../config/env.js'")
    expect(entry).toMatch(/createApp\(\{[\s\S]*\n {2}env,\n/u)
    expect(entry).toContain('config: [database, http],')
    // Host authorization is config/http.ts's now, and giving both forms fails the boot.
    expect(entry).not.toContain('hostAuthorization')
  })

  // `guren check --env` fails an app whose .env.example assigns a key the schema
  // does not declare, so a template shipping that pair fails its own gate.
  test.each(TEMPLATES)('%s declares every key its .env.example assigns', async (template) => {
    const [schema, example] = await Promise.all([
      readFile(templateFile(template, 'config/env.ts'), 'utf8'),
      readFile(templateFile(template, '.env.example'), 'utf8'),
    ])

    const keys = assignedKeys(example)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(schema).toContain(`${key}:`)
    }
  })
})
