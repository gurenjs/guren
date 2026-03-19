import { describe, expect, it } from 'bun:test'
import * as orm from '../src/index'

describe('@guren/orm', () => {
  it('exports core ORM helpers', () => {
    expect(orm.Model).toBeDefined()
    expect(orm.DrizzleAdapter).toBeDefined()
    expect(orm.createPostgresDatabase).toBeDefined()
    expect(orm.runSeeders).toBeDefined()
  })
})
