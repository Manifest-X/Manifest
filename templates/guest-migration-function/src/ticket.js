/* Migration ticket — a short-lived, signed claim that the bearer controlled a
 * specific guest account (and which teams it owned) at prepare-time.
 *
 * Why this exists: Appwrite cannot convert an anonymous account via OTP, so a
 * guest who signs in becomes a DIFFERENT user. To carry the guest's teams over
 * we must prove, at commit-time, that the (new) caller is the same person who
 * held the guest session moments earlier. The ticket is that proof: it is issued
 * only to the authenticated guest (`prepare`) and is HMAC-signed so it can't be
 * forged, then redeemed by the new account (`commit`). It binds the exact guest
 * id + team set so a stolen ticket can't be aimed at someone else's teams.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

const b64u = (s) => Buffer.from(s).toString('base64url')

export function signTicket(payload, secret, ttlSeconds = 600) {
    const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }))
    const sig = createHmac('sha256', secret).update(body).digest('base64url')
    return `${body}.${sig}`
}

export function verifyTicket(ticket, secret) {
    if (typeof ticket !== 'string' || !ticket.includes('.')) return null
    const [body, sig] = ticket.split('.')
    const expected = createHmac('sha256', secret).update(body).digest('base64url')
    const a = Buffer.from(sig), b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    let payload
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return null }
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
}
