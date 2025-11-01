export interface MockInertiaPage<TProps = Record<string, unknown>> {
  component: string
  props: TProps
  url: string
  version?: string
}

const defaultPage: MockInertiaPage = {
  component: 'TestComponent',
  props: {},
  url: '/',
  version: undefined,
}

let currentPage: MockInertiaPage = { ...defaultPage }

export function getInertiaPage<TProps>(): MockInertiaPage<TProps> {
  return currentPage as MockInertiaPage<TProps>
}

export function setInertiaPage<TProps>(
  page: Partial<MockInertiaPage<TProps>>,
): void {
  currentPage = {
    ...defaultPage,
    ...page,
    props: (page.props ?? ({} as TProps)),
  } as MockInertiaPage
}

export function resetInertiaPage(): void {
  currentPage = { ...defaultPage }
}

export function createInertiaReactMock(
  actual: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    ...actual,
    ...overrides,
    usePage: () => getInertiaPage(),
  }
}
