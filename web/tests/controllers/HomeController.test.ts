import { describe, expect, it, vi } from 'vitest'
import { createControllerContext, readInertiaResponse } from '@guren/testing'
import type { Context } from '@guren/server'
import { createControllerModuleMock } from '../../../packages/testing/dist/index.js'

vi.mock('@guren/server', () => createControllerModuleMock())

import HomeController from '../../app/Http/Controllers/HomeController.js'

describe('HomeController', () => {
  it('renders landing page metadata through inertia', async () => {
    const controller = new HomeController()
    const ctx = createControllerContext('http://guren.dev/') as unknown as Context
    controller.setContext(ctx)

    const response = await controller.index()
    const { payload } = await readInertiaResponse(response)

    expect(response.status).toBe(200)
    expect(payload.component).toBe('Home')
    expect(payload.props.message).toContain('Build full-stack web apps')
    expect(payload.url).toBe('/')
  })
})
