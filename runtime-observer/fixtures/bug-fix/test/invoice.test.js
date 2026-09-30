import assert from 'node:assert/strict'
import test from 'node:test'
import { totalInvoice } from '../src/invoice.js'

test('multiplies each price by quantity', () => {
  assert.equal(
    totalInvoice([
      { price: 12, quantity: 2 },
      { price: 5, quantity: 3 },
    ]),
    39,
  )
})

test('empty invoice totals zero', () => {
  assert.equal(totalInvoice([]), 0)
})
