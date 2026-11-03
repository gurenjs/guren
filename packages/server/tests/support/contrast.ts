/** WCAG 2.x contrast ratio of two `#rrggbb` colors, from 1 to 21. */
export function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!match) throw new Error(`not a #rrggbb color: ${hex}`)
  const [r, g, b] = match.slice(1).map((pair) => {
    const channel = Number.parseInt(pair, 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

export interface PageThemes {
  light: Record<string, string>
  dark: Record<string, string>
}

/**
 * The `--g-*` hex tokens a self-contained page declares: the first `:root` block,
 * and that block overlaid with the `:root` inside its `prefers-color-scheme: dark` query.
 */
export function pageThemes(html: string): PageThemes {
  const light = /:root\s*\{([^}]*)\}/.exec(html)?.[1]
  const dark = /prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(html)?.[1]
  if (light === undefined || dark === undefined) throw new Error('the page declares no light and dark :root blocks')
  const lightTokens = hexTokens(light)
  return { light: lightTokens, dark: { ...lightTokens, ...hexTokens(dark) } }
}

function hexTokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--g-([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map(([, name, value]) => [name!, value!]))
}

/** The token a rule's `color: var(--g-…)` names, for the rule whose selector is exactly `selector`. */
export function ruleColorToken(html: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const token = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{[^}]*?(?:^|[;\\s{])color:\\s*var\\(--g-([\\w-]+)\\)`, 'm').exec(html)?.[1]
  if (token === undefined) throw new Error(`no rule \`${selector}\` with a token color`)
  return token
}
