import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { NextFunction, Request, Response } from 'express';
import type { Address } from '../shared/types';

export interface AuthSession {
  id: string;
  tokens?: { accessToken: string; refreshToken?: string; expiresAt: number };
  userKey?: string;
  userName?: string;
  addresses: Address[];
  selectedAddressId?: string;
  capabilities: string[];
}

interface StoredSession { session: AuthSession; expiresAt: number }
interface OAuthAttempt { state: string; verifier: string; nonce: string; expiresAt: number }
const COOKIE = 'viu_pediu_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SCOPES = [
  'mcp.user.basic.read', 'mcp.user.addresses.read', 'mcp.user.addresses.write',
  'mcp.discovery.search.read', 'mcp.discovery.browse.read', 'mcp.discovery.details.read',
  'mcp.cart.read', 'mcp.cart.write', 'mcp.cart.payment', 'mcp.cart.checkout', 'mcp.orders.read',
].join(' ');

function secret(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && !/^(?:YOUR_|MY_|CHANGE_ME|COLOQUE_)/i.test(trimmed) ? trimmed : '';
}

/** OAuth credentials and consumer tokens never leave this server. */
export class AuthManager {
  private sessions = new Map<string, StoredSession>();
  private attempts = new Map<string, OAuthAttempt>();
  private refreshing = new Map<string, Promise<string>>();
  private clientId = secret(process.env.IFOOD_CLIENT_ID);
  private clientSecret = secret(process.env.IFOOD_CLIENT_SECRET);
  private redirectUri = process.env.IFOOD_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/api/auth/ifood/callback`;
  private scopes = process.env.IFOOD_SCOPES?.trim() || DEFAULT_SCOPES;
  private authorizeUrl = process.env.IFOOD_AUTHORIZE_URL || 'https://id.ifood.com.br/authorize';
  private tokenUrl = process.env.IFOOD_TOKEN_URL || 'https://id.ifood.com.br/token';
  private revokeUrl = process.env.IFOOD_REVOKE_URL || 'https://id.ifood.com.br/revoke';
  private jwks = createRemoteJWKSet(new URL(process.env.IFOOD_JWKS_URL || 'https://id.ifood.com.br/.well-known/jwks.json'), { timeoutDuration: 10_000 });
  readonly configured = Boolean(this.clientId && this.clientSecret);

  middleware = (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    for (const [id, stored] of this.sessions) {
      if (stored.expiresAt <= now) { this.sessions.delete(id); this.attempts.delete(id); }
    }
    const rawCookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`));
    const id = rawCookie?.slice(COOKIE.length + 1);
    let stored = id && /^[a-f0-9]{64}$/.test(id) ? this.sessions.get(id) : undefined;
    if (!stored) {
      const session: AuthSession = { id: randomBytes(32).toString('hex'), addresses: [], capabilities: [] };
      stored = { session, expiresAt: now + SESSION_MS };
      this.sessions.set(session.id, stored);
      res.cookie(COOKIE, session.id, this.cookieOptions());
    }
    stored.expiresAt = now + SESSION_MS;
    res.locals.session = stored.session;
    next();
  };

  private cookieOptions() {
    return { httpOnly: true, sameSite: 'lax' as const, secure: new URL(this.redirectUri).protocol === 'https:', path: '/', maxAge: SESSION_MS };
  }

  start = (req: Request, res: Response): void => {
    if (!this.configured) { res.status(503).json({ error: 'Configure as credenciais do agente iFood no servidor.', code: 'IFOOD_NOT_CONFIGURED' }); return; }
    const previous = res.locals.session as AuthSession;
    previous.tokens = undefined;
    const session = this.rotateSession(previous, res);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    this.attempts.set(session.id, { state, verifier, nonce, expiresAt: Date.now() + 10 * 60 * 1000 });
    const url = new URL(this.authorizeUrl);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: this.clientId, redirect_uri: this.redirectUri,
      scope: this.scopes, state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }).toString();
    res.redirect(url.toString());
  };

  callback = async (req: Request, res: Response): Promise<void> => {
    const session = res.locals.session as AuthSession;
    const attempt = this.attempts.get(session.id);
    this.attempts.delete(session.id);
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const stateBytes = Buffer.from(state);
    const expectedBytes = Buffer.from(attempt?.state || '');
    const valid = attempt && attempt.expiresAt > Date.now() && stateBytes.length === expectedBytes.length && timingSafeEqual(stateBytes, expectedBytes);
    if (!valid) { res.status(403).send('A autorização expirou ou o estado é inválido. Volte ao aplicativo e conecte novamente.'); return; }
    if (req.query.error) { res.redirect('/?ifood=denied'); return; }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) { res.status(400).send('O iFood não retornou um código de autorização.'); return; }
    try {
      const data = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: attempt.verifier });
      const tokens = this.parseTokens(data);
      // Persisted ownership is derived only from a verified provider identity.
      let subject: string | undefined;
      if (typeof data.id_token === 'string') {
        const { payload } = await jwtVerify(data.id_token, this.jwks, {
          issuer: process.env.IFOOD_ISSUER || 'https://id.ifood.com.br/3p', audience: this.clientId,
          algorithms: ['RS512'], requiredClaims: ['sub', 'exp', 'iat'],
        });
        if (payload.nonce !== attempt.nonce) throw new Error('Nonce de autenticação inválido.');
        subject = payload.sub;
      }
      const connected = this.rotateSession(session, res);
      connected.tokens = tokens;
      connected.userKey = subject ? createHash('sha256').update(`ifood:${subject}`).digest('hex') : connected.id;
      res.redirect('/?ifood=connected');
    } catch {
      session.tokens = undefined;
      res.redirect('/?ifood=error');
    }
  };

  private rotateSession(session: AuthSession, res: Response): AuthSession {
    this.sessions.delete(session.id);
    this.attempts.delete(session.id);
    const next: AuthSession = { id: randomBytes(32).toString('hex'), addresses: [], capabilities: [] };
    this.sessions.set(next.id, { session: next, expiresAt: Date.now() + SESSION_MS });
    res.locals.session = next;
    res.cookie(COOKIE, next.id, this.cookieOptions());
    return next;
  }

  private async tokenRequest(fields: Record<string, string>): Promise<Record<string, any>> {
    const response = await fetch(this.tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...fields, client_id: this.clientId, client_secret: this.clientSecret }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('Falha ao autorizar a sessão iFood.');
    return await response.json() as Record<string, any>;
  }

  private parseTokens(data: Record<string, any>, previousRefresh?: string): NonNullable<AuthSession['tokens']> {
    if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('Token de acesso ausente.');
    if (data.token_type && String(data.token_type).toLowerCase() !== 'bearer') throw new Error('Tipo de token inválido.');
    const seconds = Number(data.expires_in);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Expiração de token ausente.');
    return { accessToken: data.access_token, refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : previousRefresh, expiresAt: Date.now() + seconds * 1000 };
  }

  async accessToken(session: AuthSession): Promise<string> {
    if (!session.tokens) throw Object.assign(new Error('Conecte sua conta iFood para continuar.'), { code: 'AUTH_REQUIRED', status: 401 });
    if (session.tokens.expiresAt > Date.now() + 5 * 60 * 1000) return session.tokens.accessToken;
    const sessionId = session.id;
    const existing = this.refreshing.get(sessionId);
    if (existing) return existing;
    const previous = session.tokens;
    const refresh = (async () => {
      try {
        if (!previous.refreshToken) throw new Error('Sua sessão iFood expirou. Conecte novamente.');
        const data = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: previous.refreshToken });
        const tokens = this.parseTokens(data, previous.refreshToken);
        if (session.tokens !== previous) throw new Error('Sessão encerrada durante a renovação.');
        session.tokens = tokens;
        return tokens.accessToken;
      } catch {
        if (session.tokens === previous) session.tokens = undefined;
        throw Object.assign(new Error('Sua sessão iFood expirou. Conecte novamente.'), { code: 'AUTH_REQUIRED', status: 401 });
      }
    })();
    this.refreshing.set(sessionId, refresh);
    try { return await refresh; } finally { this.refreshing.delete(sessionId); }
  }

  logout = async (req: Request, res: Response): Promise<void> => {
    const session = res.locals.session as AuthSession;
    const token = session.tokens?.refreshToken || session.tokens?.accessToken;
    session.tokens = undefined;
    this.attempts.delete(session.id);
    this.sessions.delete(session.id);
    res.clearCookie(COOKIE, { ...this.cookieOptions(), maxAge: undefined });
    if (token) {
      try {
        await fetch(this.revokeUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token, client_id: this.clientId, client_secret: this.clientSecret }), signal: AbortSignal.timeout(10_000),
        });
      } catch { /* Local logout still succeeds when the provider cannot be reached. */ }
    }
    res.json({ connected: false });
  };
}
