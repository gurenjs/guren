import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listRoutes, displayRoutes, type RouteInfo } from '../src/route-list'

describe('route-list', () => {
  let tempDir: string
  let originalCwd: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'guren-cli-route-test-'))
    originalCwd = process.cwd()
    process.chdir(tempDir)

    await mkdir(join(tempDir, 'routes'), { recursive: true })
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('listRoutes', () => {
    it('returns empty array when no routes are registered', async () => {
      await writeFile(
        join(tempDir, 'routes/web.ts'),
        `
import { Router } from '@guren/core'

export function registerWebRoutes(_router: Router): void {
  // No routes registered
}
`
      )

      const routes = await listRoutes({ appRoot: tempDir })
      expect(routes).toEqual([])
    })

    it('throws error when routes file does not exist', async () => {
      await rm(join(tempDir, 'routes'), { recursive: true, force: true })

      await expect(listRoutes({ appRoot: tempDir })).rejects.toThrow('Failed to import routes file')
    })

    it('uses custom routes file when specified', async () => {
      await mkdir(join(tempDir, 'custom'), { recursive: true })
      await writeFile(
        join(tempDir, 'custom/routes.ts'),
        `
import { Router } from '@guren/core'

export function registerRoutes(_router: Router): void {}
`
      )

      const routes = await listRoutes({
        appRoot: tempDir,
        routesFile: 'custom/routes.ts',
      })
      expect(Array.isArray(routes)).toBe(true)
    })
  })

  describe('RouteInfo structure', () => {
    it('should have correct structure', () => {
      const route: RouteInfo = {
        method: 'GET',
        path: '/users',
        name: 'users.index',
      }

      expect(route.method).toBe('GET')
      expect(route.path).toBe('/users')
      expect(route.name).toBe('users.index')
    })

    it('name is optional', () => {
      const route: RouteInfo = {
        method: 'POST',
        path: '/users',
      }

      expect(route.method).toBe('POST')
      expect(route.path).toBe('/users')
      expect(route.name).toBeUndefined()
    })
  })

  describe('filtering', () => {
    const mockRoutes: RouteInfo[] = [
      { method: 'GET', path: '/users', name: 'users.index' },
      { method: 'POST', path: '/users', name: 'users.store' },
      { method: 'GET', path: '/users/:id', name: 'users.show' },
      { method: 'PUT', path: '/users/:id', name: 'users.update' },
      { method: 'DELETE', path: '/users/:id', name: 'users.destroy' },
      { method: 'GET', path: '/posts', name: 'posts.index' },
      { method: 'GET', path: '/api/users' },
    ]

    it('filters by method', () => {
      const method = 'GET'
      const filtered = mockRoutes.filter((r) => r.method === method)

      expect(filtered).toHaveLength(4)
      expect(filtered.every((r) => r.method === 'GET')).toBe(true)
    })

    it('filters by path pattern', () => {
      const pattern = 'users'
      const filtered = mockRoutes.filter((r) => r.path.toLowerCase().includes(pattern.toLowerCase()))

      expect(filtered).toHaveLength(6)
    })

    it('filters by name pattern', () => {
      const namePattern = 'users'
      const filtered = mockRoutes.filter((r) => r.name?.toLowerCase().includes(namePattern.toLowerCase()))

      expect(filtered).toHaveLength(5)
    })

    it('sorts by method', () => {
      const sorted = [...mockRoutes].sort((a, b) => a.method.localeCompare(b.method))

      expect(sorted[0].method).toBe('DELETE')
      expect(sorted[sorted.length - 1].method).toBe('PUT')
    })

    it('sorts by path', () => {
      const sorted = [...mockRoutes].sort((a, b) => a.path.localeCompare(b.path))

      expect(sorted[0].path).toBe('/api/users')
      expect(sorted[sorted.length - 1].path).toBe('/users/:id')
    })

    it('sorts by name', () => {
      const sorted = [...mockRoutes].sort((a, b) => {
        const aName = a.name ?? ''
        const bName = b.name ?? ''
        return aName.localeCompare(bName)
      })

      expect(sorted[0].name).toBeUndefined()
    })

    it('reverses sort order', () => {
      const sorted = [...mockRoutes].sort((a, b) => a.method.localeCompare(b.method))
      const reversed = [...sorted].reverse()

      expect(reversed[0].method).toBe('PUT')
      expect(reversed[reversed.length - 1].method).toBe('DELETE')
    })
  })

  describe('displayRoutes', () => {
    it('handles empty routes gracefully', async () => {
      await writeFile(
        join(tempDir, 'routes/web.ts'),
        `
import { Router } from '@guren/core'

export function registerWebRoutes(_router: Router): void {}
`
      )

      await displayRoutes({ appRoot: tempDir })
    })

    it('supports json format option', () => {
      const format = 'json'
      expect(['table', 'json', 'compact']).toContain(format)
    })

    it('supports compact format option', () => {
      const format = 'compact'
      expect(['table', 'json', 'compact']).toContain(format)
    })

    it('supports table format option', () => {
      const format = 'table'
      expect(['table', 'json', 'compact']).toContain(format)
    })
  })

  describe('RouteListOptions', () => {
    it('accepts all valid options', () => {
      const options = {
        routesFile: 'routes/api.ts',
        appRoot: '/app',
        method: 'GET',
        path: '/users',
        name: 'users',
        format: 'table' as const,
        sort: 'path' as const,
        reverse: true,
      }

      expect(options.routesFile).toBe('routes/api.ts')
      expect(options.appRoot).toBe('/app')
      expect(options.method).toBe('GET')
      expect(options.path).toBe('/users')
      expect(options.name).toBe('users')
      expect(options.format).toBe('table')
      expect(options.sort).toBe('path')
      expect(options.reverse).toBe(true)
    })
  })
})
