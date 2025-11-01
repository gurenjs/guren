import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import Login from '../../resources/js/pages/auth/Login'
import { setInertiaPage } from '@guren/testing'

describe('Login Inertia page', () => {
  it('pre-fills the email field from page props', () => {
    setInertiaPage({
      component: 'auth/Login',
      props: { email: 'demo@guren.dev', errors: {} },
      url: '/login',
    })
    render(<Login />)

    expect(screen.getByLabelText('Email')).toHaveValue('demo@guren.dev')
  })

  it('renders validation messaging from the server', () => {
    setInertiaPage({
      component: 'auth/Login',
      props: {
        email: 'demo@guren.dev',
        errors: {
          email: 'Email must be valid.',
          message: 'Invalid credentials.',
        },
      },
      url: '/login',
    })
    render(<Login />)

    expect(screen.getByText('Invalid credentials.')).toBeInTheDocument()
    expect(screen.getByText('Email must be valid.')).toBeInTheDocument()
  })
})
