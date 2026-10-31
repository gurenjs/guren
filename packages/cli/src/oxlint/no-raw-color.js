// oxlint plugin: a raw color in app UI code where a Guren UI token belongs. Tokens
// live in `resources/css/guren.css` (`--g-*`, utilities such as `bg-g-accent`), and
// carry the dark theme; `bg-white` or `#db1b1b` stays light when the system goes dark.
// Reports Tailwind palette utilities and arbitrary color values in any string outside
// a non-class JSX attribute (so a class in a constant or a `clsx()` call counts), and
// hex, color-function or named-color values in a JSX `style` prop or an SVG paint attribute.
// A class token an interpolation continues (`bg-${tone}-500`) is not judged.
// Tests: `tests/oxlint-no-raw-color.test.ts`.
import { unwrap } from './ast.js'

const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const COLOR_UTILITY =
  'bg|text|text-shadow|border(?:-[xytrblse])?|ring(?:-offset)?|inset-ring|outline|divide|fill|stroke|from|via|to|placeholder|caret|accent|decoration|shadow|inset-shadow|drop-shadow'
const PALETTE_CLASS = new RegExp(`^(?:${COLOR_UTILITY})-(?:(?:${PALETTE})-(?:50|[1-9]00|950)|black|white)$`, 'u')
// `(?![0-9a-z])`, not `\b`: Tailwind writes a space as `_`, a word character (`#fff_0%`).
const COLOR_VALUE = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![0-9a-z])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/iu
// The CSS named colors, without the keywords a token may stand beside (transparent, currentColor).
const NAMED_COLORS = new Set(
  ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood '
    + 'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray '
    + 'darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen '
    + 'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue '
    + 'firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew '
    + 'hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan '
    + 'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray '
    + 'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue '
    + 'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred '
    + 'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid '
    + 'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple '
    + 'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue '
    + 'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white '
    + 'whitesmoke yellow yellowgreen').split(' '),
)

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

/** `url(#paint)` names an SVG paint server and `'#fff'` is generated text, not a color. */
function withoutUrlsAndStrings(value) {
  return value.replace(/url\([^)]*\)|'[^']*'|"[^"]*"/giu, '')
}

/** A CSS value that is, or holds, a literal color. A named color counts only as the whole value
    (or a whole template quasi), so `1px solid red` is not judged. */
function isRawColorValue(value) {
  const stripped = withoutUrlsAndStrings(value).trim()
  return COLOR_VALUE.test(stripped) || NAMED_COLORS.has(stripped.toLowerCase())
}

function rawColorClass(token) {
  const utility = utilityOf(token)
  if (PALETTE_CLASS.test(utility)) return true
  if (!utility.endsWith(']')) return false
  // The arbitrary property `[color:#fff]`, or the arbitrary value of `bg-[#fff]` / `bg-[color:red]`.
  let inner
  if (utility.startsWith('[')) {
    inner = utility.slice(1, -1)
  } else {
    const open = utility.indexOf('-[')
    if (open === -1) return false
    inner = utility.slice(open + 2, -1)
  }
  const typed = /^[a-z-]+:/u.exec(inner)
  return isRawColorValue((typed ? inner.slice(typed[0].length) : inner).replaceAll('_', ' '))
}

// Judged on intrinsic elements only: on a component, `fill` or `color` is whatever the component
// makes of it (a variant name, say), not CSS.
const SVG_PAINT_ATTRIBUTES = new Set(['fill', 'stroke', 'stopColor', 'floodColor', 'lightingColor'])

function isPaintAttribute(node) {
  if (node.name?.type !== 'JSXIdentifier') return false
  if (node.name.name === 'style') return true
  const element = node.parent?.name
  return SVG_PAINT_ATTRIBUTES.has(node.name.name) && element?.type === 'JSXIdentifier' && /^[a-z]/u.test(element.name)
}

/** Values a paint attribute or `style={{ … }}` object holds, through nesting, spreads and conditionals. */
function* colorValues(node) {
  const n = unwrap(node)
  if (!n) return
  if (n.type === 'ObjectExpression') {
    for (const property of n.properties) {
      yield* colorValues(property.type === 'SpreadElement' ? property.argument : property.value)
    }
  } else if (n.type === 'ConditionalExpression') {
    yield* colorValues(n.consequent)
    yield* colorValues(n.alternate)
  } else if (n.type === 'LogicalExpression') {
    yield* colorValues(n.left)
    yield* colorValues(n.right)
  } else if (n.type === 'Literal' && typeof n.value === 'string') {
    yield { node: n, text: n.value }
  } else if (n.type === 'TemplateLiteral') {
    for (const quasi of n.quasis) yield { node: n, text: quasi.value.cooked ?? quasi.value.raw }
  }
}

/** `class`, `className`, and a component's own class props (`inputClassName`, `iconClass`). */
const CLASS_ATTRIBUTE = /[cC]lass(?:Name)?$/u

/** A module specifier, or a string inside a JSX attribute that is not a class list (`title`, `alt`). */
function cannotBeClasses(node) {
  if (node.parent?.source === node) return true
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === 'JSXAttribute') return n.name?.type !== 'JSXIdentifier' || !CLASS_ATTRIBUTE.test(n.name.name)
    if (n.type === 'JSXElement' || n.type === 'JSXFragment') return false
  }
  return false
}

function report(context, node, subject, hint) {
  context.report({ message: `${subject} is a raw color. ${hint}, or disable this line with the reason this color is not a token.`, node })
}

const CLASS_HINT = 'Use a Guren UI token from resources/css/guren.css (bg-g-panel, text-g-text, border-g-line, bg-g-accent, …)'

const rule = {
  create(context) {
    /** Reports `[node, tokens]` pairs, asking whether the strings can hold classes only once one matched. */
    function reportClasses(holder, pieces) {
      const found = pieces.flatMap(([node, tokens]) => tokens.filter(rawColorClass).map((token) => [node, token]))
      if (found.length === 0 || cannotBeClasses(holder)) return
      for (const [node, token] of found) report(context, node, `\`${token}\``, CLASS_HINT)
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') reportClasses(node, [[node, node.value.split(/\s+/u)]])
      },
      TemplateLiteral(node) {
        // A token at a quasi's edge that an interpolation continues (`bg-${tone}-500`) is unknown.
        reportClasses(node, node.quasis.map((quasi, i) => {
          const text = quasi.value.cooked ?? quasi.value.raw
          const tokens = text.split(/\s+/u)
          if (i > 0 && !/^\s/u.test(text)) tokens.shift()
          if (!quasi.tail && !/\s$/u.test(text)) tokens.pop()
          return [quasi, tokens]
        }))
      },
      JSXAttribute(node) {
        if (!isPaintAttribute(node)) return
        const expression = node.value?.type === 'JSXExpressionContainer' ? node.value.expression : node.value
        for (const { node: value, text } of colorValues(expression)) {
          if (isRawColorValue(text)) {
            report(context, value, `\`${text.trim()}\` in \`${node.name.name}\``, 'Use a token instead (`var(--g-accent)`, `var(--g-text)`, …)')
          }
        }
      },
    }
  },
}

export const rules = { 'no-raw-color': rule }

export default { meta: { name: 'guren-no-raw-color' }, rules }
