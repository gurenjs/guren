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

import WallpapersController from '../../app/Http/Controllers/WallpapersController.js'

describe('WallpapersController', () => {
  it('should render the wallpapers page', async () => {
    const controller = new WallpapersController()
    controller.setContext(createControllerContext('http://guren.dev/wallpapers') as unknown as Context)
    const response = await controller.index()
    const { payload } = await readInertiaResponse(response)

    expect(response.status).toBe(200)
    expect(payload.component).toBe('Wallpapers')
  })
})
