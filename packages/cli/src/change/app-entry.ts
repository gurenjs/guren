/**
 * The two lists of the application entry RFC 0040 §3 reads as facts: the `providers` and `config` arrays of the
 * `createApp({ … })` literal. An edit is those facts only when the entry differs from its base by entries added to
 * them and the imports that bind them; anything else in the file keeps it `source-edited`, and so does a literal that
 * could carry a list the reader does not see, or an added import of a name the base reads.
 */

import type { ArrayExpression, File, ObjectExpression, ObjectProperty, Statement } from '@babel/types'

import { frameworkCreateAppOptions, spellsEntryLists } from '../app-entry'
import { canonicalSyntax, referencedIdentifiers, sameComments } from '../ast-walk'
import { parseSourceFile } from '../parse-cache'

export const APP_ENTRY_LISTS = ['providers', 'config'] as const

export type AppEntryList = (typeof APP_ENTRY_LISTS)[number]

export interface AppEntryAddition {
  list: AppEntryList
  /** The identifier the entry is, which an import the change adds binds when the base has none. */
  name: string
}

function listProperty(options: ObjectExpression, list: AppEntryList): ObjectProperty | undefined {
  const matches = options.properties.filter((property): property is ObjectProperty => {
    if (property.type !== 'ObjectProperty' || property.computed) return false
    return (property.key.type === 'Identifier' && property.key.name === list) || (property.key.type === 'StringLiteral' && property.key.value === list)
  })
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * The identifiers `list` holds in the entry's `createApp()` literal, in order; `undefined` where the literal is not
 * the one {@link appEntryAdditions} reads or the list holds anything else. A name twice is two registrations.
 */
export function appEntryListNames(source: string, path: string, list: AppEntryList): string[] | undefined {
  const ast = parseSourceFile(source, path)
  const options = ast ? frameworkCreateAppOptions(ast.program) : undefined
  if (!options || !spellsEntryLists(options)) return undefined
  const property = listProperty(options, list)
  if (!property) return []
  if (property.value.type !== 'ArrayExpression') return undefined
  const names = property.value.elements.map((element) => (element?.type === 'Identifier' ? element.name : undefined))
  return names.every((name): name is string => name !== undefined) ? names : undefined
}

/** The value bindings the file imports: a type import binds no name a list can hold. */
function importLocals(ast: File): Set<string> {
  return new Set(ast.program.body.flatMap((node) => {
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type') return []
    return node.specifiers.filter((specifier) => specifier.type !== 'ImportSpecifier' || specifier.importKind !== 'type').map((specifier) => specifier.local.name)
  }))
}

/**
 * The entries `head` adds to the two lists of `base`, in order; `undefined` when the files differ by anything else
 * (an entry removed, moved or other than a name, another option, another statement) or either does not parse. An
 * added name's import is a declaration of that one binding the base does not import, and goes with the entry.
 */
export function appEntryAdditions(base: string, head: string, path: string): AppEntryAddition[] | undefined {
  const [before, after] = [parseSourceFile(base, path), parseSourceFile(head, path)]
  if (!before || !after || !sameComments(before, base, after, head)) return undefined
  const [baseOptions, headOptions] = [frameworkCreateAppOptions(before.program), frameworkCreateAppOptions(after.program)]
  if (!baseOptions || !headOptions || !spellsEntryLists(baseOptions) || !spellsEntryLists(headOptions)) return undefined
  const additions: AppEntryAddition[] = []
  for (const list of APP_ENTRY_LISTS) {
    const [old, now] = [listProperty(baseOptions, list), listProperty(headOptions, list)]
    if (!now) {
      if (old) return undefined
      continue
    }
    if (now.value.type !== 'ArrayExpression' || (old && old.value.type !== 'ArrayExpression')) continue
    const kept = old ? (old.value as ArrayExpression).elements : []
    const elements = now.value.elements
    const remaining: ArrayExpression['elements'] = []
    let at = 0
    for (const element of elements) {
      if (at < kept.length && canonicalSyntax(element) === canonicalSyntax(kept[at])) {
        remaining.push(element)
        at += 1
        continue
      }
      if (element?.type !== 'Identifier') return undefined
      additions.push({ list, name: element.name })
    }
    if (at !== kept.length) return undefined
    now.value.elements = remaining
    // The option the scaffold wrote whole, `providers: [X]`, goes as the entries it holds do.
    if (!old) headOptions.properties = headOptions.properties.filter((property) => property !== now)
  }
  const bound = importLocals(before)
  const added = new Set(additions.map((addition) => addition.name).filter((name) => !bound.has(name)))
  // An added import of a name the base reads (a global such as `process`) would capture every such read.
  const read = new Set(referencedIdentifiers(before.program))
  if ([...added].some((name) => read.has(name))) return undefined
  const body: Statement[] = []
  for (const node of after.program.body) {
    const binds = node.type === 'ImportDeclaration' ? node.specifiers.filter((specifier) => added.has(specifier.local.name)) : []
    if (binds.length === 0) {
      body.push(node)
      continue
    }
    const declaration = node as Extract<Statement, { type: 'ImportDeclaration' }>
    // One binding of a value: a type import binds nothing a list can hold, and a second name would come in with it.
    if (declaration.importKind === 'type' || declaration.specifiers.length !== 1) return undefined
    const specifier = declaration.specifiers[0]!
    if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') return undefined
    added.delete(specifier.local.name)
  }
  if (added.size > 0) return undefined
  after.program.body = body
  return canonicalSyntax(after.program) === canonicalSyntax(before.program) ? additions : undefined
}
