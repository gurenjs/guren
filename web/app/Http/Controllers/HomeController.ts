import { Controller } from '@guren/core'
import { SITE_TITLE } from '../../../config/site.js'
import { shouldUsePrerendered } from '../../Services/DocsStore.js'
import { homeSamples } from '@/.guren/home-samples.gen.js'
import { pages } from '@/.guren/pages.gen.js'

let highlightedPromise: Promise<Record<string, string>> | null = null

function getHighlightedExamples(): Promise<Record<string, string>> {
  if (shouldUsePrerendered(homeSamples.prerendered)) {
    return Promise.resolve(homeSamples.samples)
  }

  if (!highlightedPromise) {
    highlightedPromise = import('../../Services/highlight-code-examples.js')
      .then((mod) => mod.highlightCodeExamples())
      .catch((err) => {
        // Clear cache on failure so the next request can retry
        highlightedPromise = null
        throw err
      })
  }
  return highlightedPromise
}

export default class HomeController extends Controller {
  async index(): Promise<Response> {
    const codeExamples = await getHighlightedExamples()

    return this.inertia(pages.Home, { codeExamples }, {
      url: this.request.path,
      title: SITE_TITLE,
    })
  }
}
