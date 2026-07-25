import '@testing-library/jest-dom'
import { configureInertiaVitest } from '@guren/testing/vitest'

// Fixed test-only key so password-reset/email-verification token signing
// (createPasswordResetToken, createEmailVerificationToken) works under test
// without depending on a real .env file. Never used outside this suite.
process.env.APP_KEY ??= 'base64:DmubbpobAdBxPuaD0Qn1eUz5RwJeaMnVurIY6AzU5S8='

configureInertiaVitest()
