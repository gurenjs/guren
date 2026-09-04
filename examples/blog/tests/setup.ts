import '@testing-library/jest-dom'
import { configureInertiaVitest } from '@guren/testing/vitest'

// Fixed test-only key so token signing works without a real .env file.
process.env.APP_KEY ??= 'base64:DmubbpobAdBxPuaD0Qn1eUz5RwJeaMnVurIY6AzU5S8='

configureInertiaVitest()
