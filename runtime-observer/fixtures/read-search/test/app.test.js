import assert from 'node:assert/strict'
import test from 'node:test'
import { handleRequest } from '../src/app.js'

test('returns a known book', () => {
  assert.equal(handleRequest({ params: { id: 'book-1' } }).status, 200)
})

test('returns 404 for a missing book', () => {
  assert.equal(handleRequest({ params: { id: 'missing' } }).status, 404)
})
