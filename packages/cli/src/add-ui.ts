import { consola } from 'consola'
import { assertNotApiOnly } from './app-surface'
import { CliError } from './cli-error'
import { readIfExists } from './discovery'
import {
  findUiComponent,
  UI_COMPONENTS,
  uiComponentEntry,
  uiComponentPath,
  uiComponentTemplate,
  withUiDependencies,
  type UiComponentName,
} from './guren-css'
import { assertClientExportsForms } from './forms-types'
import { unifiedDiff } from './text-diff'
import { writeRoot, writeScaffoldFiles, type WriterOptions } from './utils'

export interface AddUiOptions extends WriterOptions {
  /** Component names, compared without case; empty or absent means every component. */
  names?: readonly string[]
  /** Print each existing copy against the current template and write nothing. */
  diff?: boolean
}

export interface AddUiResult {
  created: string[]
  /** One entry per component under `diff`: the diff, or why there is none. */
  diffs: { name: UiComponentName; diff: string; note?: string }[]
}

/** Every requested name resolved to a component, or a refusal naming the unknown ones. */
export function resolveUiComponentNames(names: readonly string[] = []): UiComponentName[] {
  if (names.length === 0) return [...UI_COMPONENTS]
  const unknown = names.filter((name) => !findUiComponent(name))
  if (unknown.length > 0) {
    throw new CliError(
      `guren add ui has no component named ${unknown.map((name) => `"${name}"`).join(', ')}. `
      + `Available: ${UI_COMPONENTS.map((name) => name.toLowerCase()).join(', ')}.`,
    )
  }
  return [...new Set(names.map((name) => findUiComponent(name)!))]
}

/** `guren add ui` (RFC 0036 §1): copy the token-styled components into the app, which owns them from then on. */
export async function addUi(options: AddUiOptions = {}): Promise<AddUiResult> {
  const appRoot = writeRoot(options)
  const names = resolveUiComponentNames(options.names)
  await assertNotApiOnly(appRoot, {
    does: 'guren add ui copies React components for Inertia pages into resources/js/components/ui',
    instead: 'An API-only app renders no pages to style; return JSON from its controllers',
  })

  if (options.diff) {
    const diffs: AddUiResult['diffs'] = []
    for (const name of names) {
      const path = uiComponentPath(name)
      const current = await readIfExists(appRoot, path)
      if (current === null) {
        diffs.push({ name, diff: '', note: `${path} does not exist; \`guren add ui ${name.toLowerCase()}\` writes it.` })
        continue
      }
      const diff = unifiedDiff(current, uiComponentTemplate(name), { fromLabel: `${path} (yours)`, toLabel: `${path} (template)` })
      diffs.push(diff ? { name, diff } : { name, diff, note: `${path} matches the current template.` })
    }
    return { created: [], diffs }
  }

  const toWrite = withUiDependencies(names)
  if (toWrite.includes('Field')) await assertClientExportsForms(appRoot, 'Field.tsx imports')
  const created = await writeScaffoldFiles(toWrite.map(uiComponentEntry), { ...options, cwd: appRoot, skipExisting: true })
  if (created.length === 0) consola.info('Every requested component is already in the app.')
  return { created, diffs: [] }
}
