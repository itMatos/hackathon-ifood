import test from 'node:test';
import assert from 'node:assert/strict';
import { IfoodGateway } from '../server/ifood.ts';
import type { AuthSession } from '../server/auth.ts';

for (const domain of [true, false]) test(`revoked ${domain ? 'domain' : 'HTTP'} authentication clears tokens without retry`, async () => {
  const session: AuthSession = { id: 's', userKey: 'account', tokens: { accessToken: 'token', expiresAt: Date.now() + 3600000 }, capabilities: ['getCart'], addresses: [{ id: 'a', label: 'Casa', formatted: 'Rua', latitude: 0, longitude: 0 }], selectedAddressId: 'a' };
  const gateway = new IfoodGateway({ accessToken: async () => 'token' } as any, session);
  let calls = 0;
  Object.assign(gateway, { token: 'token', client: {
    listTools: async () => ({ tools: [{ name: 'getCart', inputSchema: { type: 'object', properties: { cartId: { type: 'string' } }, required: ['cartId'] } }] }),
    callTool: async () => {
      calls++;
      if (!domain) throw Object.assign(new Error('HTTP unauthorized'), { code: 401 });
      return { structuredContent: { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Expired' } } };
    },
  } });
  await assert.rejects(gateway.call('getCart', { cartId: 'c' }), (e: any) => e.status === 401 && e.code === 'AUTH_REQUIRED');
  assert.equal(calls, 1); assert.equal(session.tokens, undefined); assert.equal(session.selectedAddressId, undefined); assert.deepEqual(session.addresses, []); assert.deepEqual(session.capabilities, []);
});
