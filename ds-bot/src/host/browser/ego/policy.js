// The page is untrusted data, and some clicks are not browsing. This module keeps
// the decisions small and testable: which URLs may be opened, which labels look like
// a payment, and how a URL is written to the audit log without query parameters.

const PAYMENT = /(^|\b)(pay|payment|purchase|buy|checkout|order|transfer|donate|subscribe|支付|付款|购买|下单|结算|转账|充值|订阅)(\b|$)/i

export function parseWebUrl(value) {
  let url
  try {
    url = new URL(String(value ?? ''))
  } catch {
    throw new Error('That is not a valid URL. Nothing was opened.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs can be opened. Nothing was opened.')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('URLs with embedded credentials are not allowed. Nothing was opened.')
  }
  if (url.hostname === '') throw new Error('That URL has no host. Nothing was opened.')
  return url
}

/** Payment is never delegated, even when the label is the only signal we have. */
export function paymentLike(label) {
  return typeof label === 'string' && PAYMENT.test(label)
}

export function paymentError(host) {
  return new Error(`This looks like a payment on ${host || 'the current page'}. The user makes payments themselves: call ego_handoff with reason "payment" and stop. Nothing was done.`)
}

/** Audit stores an origin and a path, never a query, fragment or credentials. */
export function auditUrl(value) {
  try {
    const url = new URL(String(value ?? ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return `${url.origin}${url.pathname}`.slice(0, 500)
  } catch {
    return ''
  }
}
