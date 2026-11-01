import { walk, type BabelNode } from '../src/ast-walk'
import { parseSourceFile } from '../src/parse-cache'

/**
 * A form submitted before React hydrates is a native submit: with no `method` it is a GET that
 * puts every named field, a password included, in the URL. One problem per `<form>` that does
 * not say `method="post"` with an `action`; a file that does not parse throws.
 */
export function formTagProblems(source: string, file = 'page.tsx'): string[] {
  const ast = parseSourceFile(source, file)
  if (!ast) throw new Error(`${file} does not parse`)
  const problems: string[] = []
  walk(ast.program, (node) => {
    if (node.type !== 'JSXOpeningElement') return
    const name = node.name as BabelNode
    if (name.type !== 'JSXIdentifier' || name.name !== 'form') return
    const attribute = (key: string): string | null => {
      const attr = (node.attributes as BabelNode[]).find((a) => a.type === 'JSXAttribute' && (a.name as BabelNode).name === key)
      const value = attr?.value as BabelNode | null | undefined
      if (!value) return null
      return value.type === 'StringLiteral' ? (value.value as string) : source.slice(value.start as number, value.end as number)
    }
    const method = attribute('method')
    const action = attribute('action')
    if (method !== 'post' || !action || action === '{undefined}') {
      problems.push(`${file}:${node.loc?.start.line}: method=${method} action=${action}`)
    }
  })
  return problems
}
