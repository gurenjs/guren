// Live shiki highlighting for the landing-page samples. Never import this
// module statically from the request path — HomeController loads it via
// dynamic import only when prerendered samples are not available.
import { codeToHtml } from 'shiki'

import { HOME_CODE_EXAMPLES, HOME_SHIKI_THEME } from './home-code-examples.js'

export async function highlightCodeExamples(): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(HOME_CODE_EXAMPLES).map(async ([key, code]) => {
      const html = await codeToHtml(code, { lang: 'typescript', theme: HOME_SHIKI_THEME })
      return [key, html] as const
    }),
  )

  return Object.fromEntries(entries)
}
