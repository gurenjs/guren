import { describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
  readInertiaResponse,
} from '../../../packages/testing/src/controller.js'
import type { Context } from '@guren/core'

vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return { ...actual, ...createControllerModuleMock() }
})

import StartController from '../../app/Http/Controllers/StartController.js'
import { DEFAULT_START_OPTIONS } from '../../resources/js/lib/start-command.js'

async function render(url: string) {
  const controller = new StartController()
  controller.setContext(createControllerContext(url) as unknown as Context)
  const response = await controller.index()
  return { response, ...(await readInertiaResponse(response)) }
}

describe('StartController', () => {
  it('renders the defaults for a bare visit', async () => {
    const { response, payload } = await render('http://guren.dev/start')

    expect(response.status).toBe(200)
    expect(payload.component).toBe('Start')
    expect(payload.props.initial).toEqual(DEFAULT_START_OPTIONS)
  })

  it('renders the choices a shared link carries, so the server and the browser agree', async () => {
    const { payload } = await render('http://guren.dev/start?db=postgres&mode=spa&agents=codex,cursor&git=0')

    expect(payload.props.initial).toEqual({
      ...DEFAULT_START_OPTIONS,
      db: 'postgres',
      mode: 'spa',
      agents: ['codex', 'cursor'],
      git: false,
    })
  })

  it('renders the page for values it does not know rather than rejecting the link', async () => {
    const { response, payload } = await render('http://guren.dev/start?db=oracle&blueprint=')

    expect(response.status).toBe(200)
    expect(payload.props.initial).toEqual(DEFAULT_START_OPTIONS)
  })
})
