// oxlint plugin: a raw color in app UI code where a Guren UI token belongs. Tokens
// live in `resources/css/guren.css` (`--g-*`, utilities such as `bg-g-accent`), and
// carry the dark theme; `bg-white` or `#db1b1b` stays light when the system goes dark.
// Reports Tailwind palette utilities and arbitrary color values in any string (so a
// class held in a constant or passed to `clsx()` counts), and hex or color-function
// literals in a JSX `style` prop or an SVG paint attribute. A class built by
// interpolation (`bg-${tone}-500`) is not judged.
// Tests: `tests/oxlint-no-raw-color.test.ts`.
import { unwrap } from './ast.js'

const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const COLOR_UTILITY =
  'bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|inset-ring|outline|divide|fill|stroke|from|via|to|placeholder|caret|accent|decoration|shadow|inset-shadow|drop-shadow'
const PALETTE_CLASS = new RegExp(`^(?:${COLOR_UTILITY})-(?:(?:${PALETTE})-(?:50|[1-9]00|950)|black|white)$`, 'u')
const COLOR_VALUE = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/iu

/** Index of the last `char` outside `[...]`, since an arbitrary value may hold one. */
function lastOutsideBrackets(token, char) {
  let depth = 0
  for (let i = token.length - 1; i >= 0; i--) {
    if (token[i] === ']') depth++
    else if (token[i] === '[') depth--
    else if (depth === 0 && token[i] === char) return i
  }
  return -1
}

/** `md:hover:!bg-red-500/50` → `bg-red-500`: the utility under its variants, `!` and opacity. */
function utilityOf(token) {
  let utility = token.slice(lastOutsideBrackets(token, ':') + 1).replace(/^!|!$/gu, '')
  const slash = lastOutsideBrackets(utility, '/')
  if (slash !== -1) utility = utility.slice(0, slash)
  return utility
}

function rawColorClass(token) {
  const utility = utilityOf(token)
  if (PALETTE_CLASS.test(utility)) return true
  const open = utility.indexOf('-[')
  return open !== -1 && utility.endsWith(']') && COLOR_VALUE.test(utility.slice(open + 2, -1))
}

const PAINT_ATTRIBUTES = new Set(['style', 'fill', 'stroke', 'color', 'stopColor', 'floodColor', 'lightingColor'])

const TOKEN_HINT = 'Use a Guren UI token from resources/css/guren.css (bg-g-panel, text-g-text, border-g-line, bg-g-accent, …)'

function reportClasses(context, node, text) {
  for (const token of text.split(/\s+/u)) {
    if (token === '' || !rawColorClass(token)) continue
    context.report({
      message: `\`${token}\` is a raw color. ${TOKEN_HINT}, or disable this line with the reason this color is not a token.`,
      node,
    })
  }
}

/** The values of a `style={{ … }}` object, through nesting and conditionals. */
function* styleValues(node) {
  const n = unwrap(node)
  if (!n) return
  if (n.type === 'ObjectExpression') {
    for (const property of n.properties) {
      if (property.type === 'Property') yield* styleValues(property.value)
    }
  } else if (n.type === 'ConditionalExpression') {
    yield* styleValues(n.consequent)
    yield* styleValues(n.alternate)
  } else if (n.type === 'LogicalExpression') {
    yield* styleValues(n.left)
    yield* styleValues(n.right)
  } else if (n.type === 'Literal' && typeof n.value === 'string') {
    yield { node: n, text: n.value }
  } else if (n.type === 'TemplateLiteral') {
    for (const quasi of n.quasis) yield { node: n, text: quasi.value.cooked ?? quasi.value.raw }
  }
}

function isModuleSpecifier(node) {
  const parent = node.parent
  if (!parent) return false
  if (parent.type === 'ImportDeclaration' || parent.type === 'ExportAllDeclaration' || parent.type === 'ExportNamedDeclaration') {
    return parent.source === node
  }
  return parent.type === 'ImportExpression'
}

const rule = {
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== 'string' || isModuleSpecifier(node)) return
        reportClasses(context, node, node.value)
      },
      TemplateElement(node) {
        reportClasses(context, node, node.value.cooked ?? node.value.raw)
      },
      JSXAttribute(node) {
        if (node.name?.type !== 'JSXIdentifier' || !PAINT_ATTRIBUTES.has(node.name.name)) return
        const expression = node.value?.type === 'JSXExpressionContainer' ? node.value.expression : node.value
        for (const { node: value, text } of styleValues(expression)) {
          if (!COLOR_VALUE.test(text)) continue
          context.report({
            message:
              `\`${text.trim()}\` in \`${node.name.name}\` is a raw color. Use a token instead (\`var(--g-accent)\`, \`var(--g-text)\`, …), `
              + 'or disable this line with the reason this color is not a token.',
            node: value,
          })
        }
      },
    }
  },
}

export const rules = { 'no-raw-color': rule }

export default { meta: { name: 'guren-no-raw-color' }, rules }
