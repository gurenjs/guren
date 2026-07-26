export interface Widget {
  slug: string
  title: string
}

export function listWidgets(): Widget[] {
  return [{ slug: 'gauge', title: 'Gauge' }]
}
