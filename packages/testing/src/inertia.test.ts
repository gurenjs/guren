import { describe, expect, it } from 'vitest'
import {
  createInertiaReactMock,
  getInertiaPage,
  resetInertiaPage,
  setInertiaPage,
} from './inertia'

describe('inertia helpers', () => {
  it('sets and resets the current page', () => {
    setInertiaPage({ component: 'Dashboard', props: { count: 2 }, url: '/dashboard' })
    expect(getInertiaPage()).toMatchObject({
      component: 'Dashboard',
      props: { count: 2 },
      url: '/dashboard',
    })

    resetInertiaPage()
    expect(getInertiaPage()).toMatchObject({
      component: 'TestComponent',
      props: {},
      url: '/',
    })
  })

  it('creates a React mock that exposes usePage', () => {
    setInertiaPage({ component: 'Profile', props: { name: 'Ada' }, url: '/profile' })
    const mock = createInertiaReactMock()

    expect(typeof mock.usePage).toBe('function')
    expect(mock.usePage()).toMatchObject({
      component: 'Profile',
      props: { name: 'Ada' },
    })
  })
})
