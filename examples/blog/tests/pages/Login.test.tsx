import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import Login from '../../resources/js/pages/auth/Login.js'

describe('Login Inertia page', () => {
  it('pre-fills the email field from page props', () => {
    render(<Login email="demo@guren.dev" errors={{}} />)

    expect(screen.getByLabelText('Email address')).toHaveValue('demo@guren.dev')
  })

  it('renders validation messaging from the server', () => {
    render(<Login
      email="demo@guren.dev"
      errors={{
        email: 'Email must be valid.',
        message: 'Invalid credentials.',
      }}
    />)

    expect(screen.getByText('Invalid credentials.')).toBeInTheDocument()
    expect(screen.getByText('Email must be valid.')).toBeInTheDocument()
  })
})
