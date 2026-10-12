import { Controller } from '@guren/core'
import { z } from 'zod'
import { pageTitle } from '../../../config/site.js'
import { startOptionsFromQuery } from '../../../resources/js/lib/start-command.js'
import { pages } from '@/.guren/pages.gen.js'

// Every field is read leniently by startOptionsFromQuery(): a shared link from
// before an option was renamed still renders, with that field at its default.
export const StartQuerySchema = z.object({
  name: z.string().optional(),
  blueprint: z.string().optional(),
  mode: z.string().optional(),
  db: z.string().optional(),
  auth: z.string().optional(),
  agents: z.string().optional(),
  git: z.string().optional(),
})

export default class StartController extends Controller {
  async index(): Promise<Response> {
    const initial = startOptionsFromQuery(this.validateQuery(StartQuerySchema))
    return this.inertia(pages.Start, { initial }, { title: pageTitle('Start a new app') })
  }
}
