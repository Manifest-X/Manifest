// In-page Appwrite stand-in that acts as a real WebAuthn relying party:
// challenges, origin and ES256 signatures are all verified.
(function () {
  const enc = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const dec = s => { const b = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(b + '='.repeat((4 - b.length % 4) % 4)), c => c.charCodeAt(0)); };
  const uid = () => 'id' + Math.random().toString(36).slice(2, 12);
  const fail = (type, code = 400) => Object.assign(new Error(type), { type, code });
  const now = () => new Date().toISOString();

  // Kept across reloads, like a server
  const db = window.__rp = JSON.parse(localStorage.getItem('rp') || 'null') || { users: {}, session: null, passkeys: [], challenges: {}, tokens: {}, calls: [] };
  const save = () => localStorage.setItem('rp', JSON.stringify(db));

  function requireSession() { if (!db.session) throw fail('general_unauthorized_scope', 401); return db.users[db.session.userId]; }
  function startSession(userId, provider) {
    db.session = { $id: uid(), userId, provider, current: true, $createdAt: now() };
    return { ...db.session };
  }
  // Test helper: an ordinary (non-guest) signed-in account
  window.__signIn = (provider = 'magic-url') => {
    const user = { $id: uid(), name: 'Ada', email: 'ada@example.test' };
    db.users[user.$id] = user;
    const session = startSession(user.$id, provider);
    save();
    return session;
  };

  function clientData(credential, type, challenge) {
    const data = JSON.parse(new TextDecoder().decode(dec(credential.response.clientDataJSON)));
    if (data.type !== type || data.challenge !== challenge || data.origin !== location.origin) throw fail('user_passkey_invalid', 401);
  }
  function derToRaw(der) {
    let o = 2; if (der[1] & 0x80) o += der[1] & 0x7f;
    const int = () => { const len = der[o + 1]; let v = der.slice(o + 2, o + 2 + len); o += 2 + len; while (v.length > 32) v = v.slice(1); const out = new Uint8Array(32); out.set(v, 32 - v.length); return out; };
    const r = int(), s = int(); const raw = new Uint8Array(64); raw.set(r); raw.set(s, 32); return raw;
  }

  class Client { constructor() { this.headers = {}; this.config = {}; } setEndpoint() { return this; } setProject() { return this; } }
  class Teams { async list() { return { total: 0, teams: [] }; } }
  class Account {
    async get() { return { ...requireSession() }; }
    async listSessions() { requireSession(); return { total: 1, sessions: [{ ...db.session }] }; }
    async createAnonymousSession() { const user = { $id: uid(), name: '' }; db.users[user.$id] = user; return startSession(user.$id, 'anonymous'); }
    async deleteSession() { requireSession(); db.session = null; return {}; }
    async createSession(userId, secret) {
      db.calls.push(['createSession', userId, secret]);
      if (db.session) throw fail('user_session_already_exists', 401);
      if (!secret || db.tokens[secret] !== userId) throw fail('user_invalid_token', 401);
      delete db.tokens[secret];
      return startSession(userId, 'passkey');
    }

    async createPasskey(params = {}) {
      db.calls.push(['createPasskey', params]);
      const user = requireSession();
      const mine = db.passkeys.filter(p => p.userId === user.$id && p.verified);
      const challenge = enc(crypto.getRandomValues(new Uint8Array(32)));
      const passkey = { $id: params.passkeyId || uid(), userId: user.$id, name: params.name || '', verified: false, challenge, $createdAt: now(), $updatedAt: now(), accessedAt: '' };
      db.passkeys.push(passkey);
      return {
        $id: uid(), passkeyId: passkey.$id, expire: now(),
        publicKey: {
          rp: { id: 'localhost', name: 'Passkey e2e' },
          user: { id: enc(new TextEncoder().encode(user.$id)), name: user.email || user.$id, displayName: user.name || user.$id },
          challenge,
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          excludeCredentials: mine.map(p => ({ type: 'public-key', id: p.credentialId })),
        },
      };
    }
    async updatePasskeyVerification({ passkeyId, credential }) {
      const user = requireSession();
      const passkey = db.passkeys.find(p => p.$id === passkeyId && p.userId === user.$id && !p.verified);
      if (!passkey) throw fail('user_passkey_not_found', 404);
      clientData(credential, 'webauthn.create', passkey.challenge);
      if (!credential.response.attestationObject || !credential.response.publicKey) throw fail('user_passkey_invalid', 401);
      Object.assign(passkey, { verified: true, credentialId: credential.id, publicKey: credential.response.publicKey });
      return { $id: passkey.$id, name: passkey.name, $createdAt: passkey.$createdAt, $updatedAt: passkey.$updatedAt, accessedAt: '' };
    }
    async createPasskeyToken() {
      const $id = uid();
      const challenge = enc(crypto.getRandomValues(new Uint8Array(32)));
      db.challenges[$id] = challenge;
      return { $id, passkeyId: '', expire: now(), publicKey: { challenge, rpId: 'localhost', userVerification: 'required' } };
    }
    async updatePasskeyToken({ challengeId, credential }) {
      const challenge = db.challenges[challengeId];
      delete db.challenges[challengeId];
      if (!challenge) throw fail('user_invalid_token', 401);
      clientData(credential, 'webauthn.get', challenge);
      const passkey = db.passkeys.find(p => p.verified && p.credentialId === credential.id);
      if (!passkey) throw fail('user_passkey_invalid', 401);
      const key = await crypto.subtle.importKey('spki', dec(passkey.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const authData = dec(credential.response.authenticatorData);
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', dec(credential.response.clientDataJSON)));
      const signed = new Uint8Array(authData.length + hash.length); signed.set(authData); signed.set(hash, authData.length);
      const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(dec(credential.response.signature)), signed);
      if (!ok) throw fail('user_passkey_invalid', 401);
      passkey.accessedAt = now();
      const secret = uid();
      db.tokens[secret] = passkey.userId;
      return { $id: uid(), userId: passkey.userId, secret, expire: now() };
    }
    async listPasskeys() {
      const user = requireSession();
      const passkeys = db.passkeys.filter(p => p.userId === user.$id && p.verified).map(p => ({ $id: p.$id, name: p.name, $createdAt: p.$createdAt, $updatedAt: p.$updatedAt, accessedAt: p.accessedAt }));
      return { total: passkeys.length, passkeys };
    }
    async updatePasskey({ passkeyId, name }) {
      const user = requireSession();
      const p = db.passkeys.find(x => x.$id === passkeyId && x.userId === user.$id);
      if (!p) throw fail('user_passkey_not_found', 404);
      p.name = name;
      return { $id: p.$id, name: p.name, $createdAt: p.$createdAt, $updatedAt: now(), accessedAt: p.accessedAt };
    }
    async deletePasskey({ passkeyId }) {
      const user = requireSession();
      const i = db.passkeys.findIndex(x => x.$id === passkeyId && x.userId === user.$id);
      if (i < 0) throw fail('user_passkey_not_found', 404);
      db.passkeys.splice(i, 1);
      return {};
    }
  }
  for (const name of Object.getOwnPropertyNames(Account.prototype)) {
    const fn = Account.prototype[name];
    if (name !== 'constructor') Account.prototype[name] = async function (...args) { try { return await fn.apply(this, args); } finally { save(); } };
  }
  window.Appwrite = { Client, Account, Teams, ID: { unique: uid }, Query: {} };
})();
