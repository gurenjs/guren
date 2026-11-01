import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addUi, resolveUiComponentNames } from '../src/add-ui'
import { CliError } from '../src/cli-error'
import { getDoctorRuleEvaluations } from '../src/doctor'
import {
  ensureUiComponents,
  planUiComponent,
  SHIPPED_UI_COMPONENTS,
  UI_COMPONENTS,
  uiComponentHash,
  uiComponentPath,
  uiComponentsImportedBy,
  uiComponentTemplate,
} from '../src/guren-css'
import { upgradeCanary } from '../src/upgrade'
import { createTempWorkspace, OXLINT_BIN, seedApiOnlyApp, seedInertiaApp, type TempWorkspace } from './helpers'

const repoRoot = join(import.meta.dir, '../../..')
const TEMPLATE_DIR = join(import.meta.dir, '../templates/scaffold/ui/resources/js/components/ui')
const STARTER_DIR = join(repoRoot, 'packages/create-app/templates/default/resources/js/components/ui')

describe('the shipped component templates', () => {
  it('ship exactly the components the CLI lists', async () => {
    expect((await readdir(TEMPLATE_DIR)).sort()).toEqual(UI_COMPONENTS.map((name) => `${name}.tsx`))
  })

  // A changed template whose earlier hash is missing reads as an edited copy in every app that has it.
  it.each([...UI_COMPONENTS])('%s is listed in SHIPPED_UI_COMPONENTS, under a header naming its version count', (name) => {
    const template = uiComponentTemplate(name)
    const released = SHIPPED_UI_COMPONENTS[name]
    expect(released.has(uiComponentHash(template))).toBe(true)
    expect(template.split('\n')[0]).toStartWith(`// guren-ui: ${name} v${released.size}. `)
  })

  // The generators gate Field on the client exporting ./forms, which the first forms release does without later names.
  it('Field imports only what the first client exporting ./forms exports', () => {
    const imported = /import \{([^}]+)\} from '@guren\/inertia-client\/forms'/u.exec(uiComponentTemplate('Field'))?.[1] ?? ''
    const names = imported.split(',').map((name) => name.replace(/^\s*type\s+/u, '').trim()).filter(Boolean).sort()
    expect(names).toEqual(['FieldInput', 'FieldOption', 'FieldState', 'FormDataType', 'useField'])
  })

  it('are the copies create-guren-app ships', () => {
    for (const name of UI_COMPONENTS) {
      expect(readFileSync(join(STARTER_DIR, `${name}.tsx`), 'utf8')).toBe(uiComponentTemplate(name))
    }
  })

  // An app has oxlint and `lint:fix`, no formatter: a fix that rewrote a copy would make it read as edited.
  it('are left alone by the scaffolded app\'s lint --fix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guren-ui-lint-fix-'))
    try {
      cpSync(TEMPLATE_DIR, join(dir, 'resources/js/components/ui'), { recursive: true })
      const config = readFileSync(join(repoRoot, 'packages/create-app/templates/default/.oxlintrc.json'), 'utf8')
      const plugin = JSON.stringify(join(repoRoot, 'packages/cli/src/oxlint/index.js'))
      expect(config).toContain('"@guren/cli/oxlint"')
      writeFileSync(join(dir, '.oxlintrc.json'), config.replace('"@guren/cli/oxlint"', plugin))
      const result = Bun.spawnSync(
        [OXLINT_BIN, '--disable-nested-config', '-c', '.oxlintrc.json', '--fix', '--format', 'unix', 'resources/js'],
        { cwd: dir, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(result.stderr.toString()).toBe('')
      expect(result.stdout.toString()).toBe('')
      for (const name of UI_COMPONENTS) {
        expect(readFileSync(join(dir, uiComponentPath(name)), 'utf8')).toBe(uiComponentTemplate(name))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('planUiComponent', () => {
  const template = '// guren-ui: Button v2. note\nexport const b = 2\n'
  const earlier = '// guren-ui: Button v1. note\nexport const b = 1\n'
  const released = new Set([uiComponentHash(earlier), uiComponentHash(template)])

  it('passes the current template, with either line end', () => {
    expect(planUiComponent(template, template, released)).toEqual({ kind: 'current' })
    expect(planUiComponent(template.replace(/\n/g, '\r\n'), template, released)).toEqual({ kind: 'current' })
  })

  it('replaces an unedited copy of an earlier release', () => {
    expect(planUiComponent(earlier, template, released)).toEqual({ kind: 'update', next: template })
  })

  it('leaves an edited copy, naming the version its header claims', () => {
    expect(planUiComponent(`${earlier}// mine\n`, template, released)).toEqual({ kind: 'edited', claimed: 'Button v1' })
    expect(planUiComponent('export const b = 3\n', template, released)).toEqual({ kind: 'edited' })
  })

  // A formatter's rewrite is an edit: undoing it would need a parse, and a wrong "unedited" overwrites the app's work.
  it('reads a reformatted copy as edited', () => {
    expect(planUiComponent(template.replace('= 2', '= 2;'), template, released).kind).toBe('edited')
  })
})

describe('the guren-ui-components doctor rule', () => {
  let workspace: TempWorkspace
  const componentsCheck = async () =>
    (await getDoctorRuleEvaluations({ cwd: workspace.dir })).evaluations.find((evaluation) => evaluation.check.key === 'guren-ui-components')!
  const copy = (name: (typeof UI_COMPONENTS)[number]): string => join(workspace.dir, uiComponentPath(name))

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-ui-components-doctor-')
    await writeFile(join(workspace.dir, 'package.json'), JSON.stringify({ name: 'components-test' }), 'utf8')
    await mkdir(join(workspace.dir, 'resources/js/components/ui'), { recursive: true })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('passes an app with no copied components', async () => {
    expect((await componentsCheck()).check.status).toBe('pass')
  })

  it('passes copies identical to the current templates', async () => {
    await writeFile(copy('Button'), uiComponentTemplate('Button'), 'utf8')
    await writeFile(copy('Alert'), uiComponentTemplate('Alert').replace(/\n/g, '\r\n'), 'utf8')
    expect((await componentsCheck()).check.status).toBe('pass')
  })

  it('reports an edited copy with the diff command, and offers no autofix', async () => {
    await writeFile(copy('Input'), `${uiComponentTemplate('Input')}// mine\n`, 'utf8')
    const { check, autofix } = await componentsCheck()
    expect(check.status).toBe('warn')
    expect(check.message).toContain('its header names Input v2')
    expect(check.manualFix).toContain('`guren add ui input --diff`')
    expect(autofix).toBeNull()
  })

  it('replaces an unedited copy of an earlier release through guren upgrade, previewed under --dry-run', async () => {
    const earlier = '// guren-ui: Card v0. an earlier release\nexport {}\n'
    const released = SHIPPED_UI_COMPONENTS.Card as Set<string>
    released.add(uiComponentHash(earlier))
    try {
      await writeFile(copy('Card'), earlier, 'utf8')
      const { check, autofix } = await componentsCheck()
      expect(check.status).toBe('warn')
      expect(autofix).not.toBeNull()

      const preview = await upgradeCanary({ cwd: workspace.dir, tag: 'canary', dryRun: true })
      expect(preview.autofixes.find((entry) => entry.key === 'guren-ui-components')?.applied).toBe(false)
      expect(await readFile(copy('Card'), 'utf8')).toBe(earlier)

      const result = await upgradeCanary({ cwd: workspace.dir, tag: 'canary' })
      expect(result.autofixes.find((entry) => entry.key === 'guren-ui-components')?.applied).toBe(true)
      expect(await readFile(copy('Card'), 'utf8')).toBe(uiComponentTemplate('Card'))
    } finally {
      released.delete(uiComponentHash(earlier))
    }
  })
})

describe('guren add ui', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-add-ui-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('writes every component and the token sheet, and leaves existing copies on a re-run', async () => {
    await seedInertiaApp(workspace.dir)
    const created = await addUi()
    expect(created.created).toHaveLength(UI_COMPONENTS.length)
    for (const name of UI_COMPONENTS) {
      expect(await readFile(join(workspace.dir, uiComponentPath(name)), 'utf8')).toBe(uiComponentTemplate(name))
    }
    expect(await readFile(join(workspace.dir, 'resources/css/guren.css'), 'utf8')).toContain('guren:tokens begin')

    await writeFile(join(workspace.dir, uiComponentPath('Button')), '// mine\n', 'utf8')
    rmSync(join(workspace.dir, uiComponentPath('Label')))
    const rerun = await addUi()
    // The command writes under process.cwd(), the realpath of the macOS tmpdir symlink.
    expect(rerun.created).toEqual([join(await realpath(workspace.dir), uiComponentPath('Label'))])
    expect(await readFile(join(workspace.dir, uiComponentPath('Button')), 'utf8')).toBe('// mine\n')
  })

  it('writes only the named components, matched without case', async () => {
    await seedInertiaApp(workspace.dir)
    const { created } = await addUi({ names: ['button', 'CARD'] })
    const root = await realpath(workspace.dir)
    expect(created).toEqual([join(root, uiComponentPath('Button')), join(root, uiComponentPath('Card'))])
  })

  it('replaces an existing copy under --force', async () => {
    await seedInertiaApp(workspace.dir)
    await mkdir(join(workspace.dir, 'resources/js/components/ui'), { recursive: true })
    await writeFile(join(workspace.dir, uiComponentPath('Button')), '// mine\n', 'utf8')
    await addUi({ names: ['button'], force: true })
    expect(await readFile(join(workspace.dir, uiComponentPath('Button')), 'utf8')).toBe(uiComponentTemplate('Button'))
  })

  it('prints an edited copy against the template under --diff, and writes nothing', async () => {
    await seedInertiaApp(workspace.dir)
    await mkdir(join(workspace.dir, 'resources/js/components/ui'), { recursive: true })
    const edited = uiComponentTemplate('Button').replace("type = 'button'", "type = 'submit'")
    await writeFile(join(workspace.dir, uiComponentPath('Button')), edited, 'utf8')

    const { created, diffs } = await addUi({ names: ['button', 'label'], diff: true })
    expect(created).toEqual([])
    expect(diffs[0]!.diff).toContain("-export function Button({ variant, size, block, className, type = 'submit', ...props }: ButtonProps) {")
    expect(diffs[0]!.diff).toContain("+export function Button({ variant, size, block, className, type = 'button', ...props }: ButtonProps) {")
    expect(diffs[1]!.note).toContain('does not exist')
    expect(await readFile(join(workspace.dir, uiComponentPath('Button')), 'utf8')).toBe(edited)
  })

  it('refuses an unknown component name, naming the available ones', () => {
    expect(() => resolveUiComponentNames(['button', 'tabs'])).toThrow(CliError)
    expect(() => resolveUiComponentNames(['tabs'])).toThrow('Available: alert, button, card')
  })

  it('writes the components Field imports along with it', async () => {
    await seedInertiaApp(workspace.dir)
    await addUi({ names: ['field'] })
    const written = (await readdir(join(workspace.dir, 'resources/js/components/ui'))).sort()
    expect(written).toEqual(['Checkbox.tsx', 'Field.tsx', 'Input.tsx', 'Label.tsx', 'Select.tsx', 'Textarea.tsx'])
  })

  it('refuses Field before writing when the installed client predates the forms subpath', async () => {
    await seedInertiaApp(workspace.dir)
    const client = join(workspace.dir, 'node_modules/@guren/inertia-client')
    await mkdir(client, { recursive: true })
    await writeFile(join(client, 'package.json'), JSON.stringify({ name: '@guren/inertia-client', exports: { './package.json': './package.json' } }))
    await expect(addUi({ names: ['field'] })).rejects.toThrow('bun add @guren/inertia-client@latest')
    expect(await readFile(join(workspace.dir, uiComponentPath('Field')), 'utf8').catch(() => null)).toBeNull()
    await addUi({ names: ['button'] })
    expect(await readFile(join(workspace.dir, uiComponentPath('Button')), 'utf8')).toBe(uiComponentTemplate('Button'))
  })

  it('refuses an API-only app', async () => {
    await seedApiOnlyApp(workspace.dir)
    await expect(addUi()).rejects.toThrow('API-only app')
  })
})

describe('ensureUiComponents', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-ensure-ui-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('writes the components a batch imports that the app lacks, and never touches one it has', async () => {
    const page = {
      path: 'resources/js/pages/posts/New.tsx',
      contents: "import { Button } from '@/resources/js/components/ui/Button'\nimport { Label } from '@/resources/js/components/ui/Label'\n",
    }
    expect(uiComponentsImportedBy([page])).toEqual(['Button', 'Label'])

    await mkdir(join(workspace.dir, 'resources/js/components/ui'), { recursive: true })
    await writeFile(join(workspace.dir, uiComponentPath('Button')), '// mine\n', 'utf8')
    expect(await ensureUiComponents(workspace.dir, uiComponentsImportedBy([page]))).toEqual([join(workspace.dir, uiComponentPath('Label'))])
    expect(await readFile(join(workspace.dir, uiComponentPath('Button')), 'utf8')).toBe('// mine\n')
  })
})
