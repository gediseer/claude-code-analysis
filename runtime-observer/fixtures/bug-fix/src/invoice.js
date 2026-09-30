export function totalInvoice(items) {
  return items.reduce((total, item) => total + item.price, 0)
}
