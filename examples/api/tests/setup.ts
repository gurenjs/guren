import { vi } from 'vitest'

vi.mock('../config/database.js', () => ({
  getDatabase: vi.fn(),
  migrateDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  configureOrm: vi.fn(),
  seedDatabase: vi.fn(),
}))
