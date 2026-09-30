export const catalog = new Map([
  ['book-1', { id: 'book-1', title: 'Agent Systems' }],
  ['book-2', { id: 'book-2', title: 'Retrieval Systems' }],
])

export function findBook(id) {
  return catalog.get(id) ?? null
}
