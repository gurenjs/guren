// Minimal setup for API tests
import { vi } from 'vitest'

// Mock database for tests
vi.mock('../config/database.js', () => ({
  getDatabase: vi.fn(),
  migrateDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  configureOrm: vi.fn(),
  seedDatabase: vi.fn(),
}))
