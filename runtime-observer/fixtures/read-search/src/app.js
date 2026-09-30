import { findBook } from './catalog.js'

export function handleRequest(request) {
  const book = findBook(request.params.id)
  return book
    ? { status: 200, body: book }
    : { status: 404, body: { error: 'not found' } }
}
