import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AuthManager, type AuthSession } from '../server/auth.ts';
import { AGENT_READ_TOOLS, runAgent } from '../server/agent.ts';
import { IfoodGateway, normalizeAddresses, normalizeItems, normalizeOffers, unwrapToolResult, type ToolGateway } from '../server/ifood.ts';

function response(session?: AuthSession): any {
  return { locals: { session }, cookies: [] as any[], statusCode: 200,
    cookie(name: string, value: string, options: any) { this.cookies.push({ name, value, options }); return this; },
    clearCookie(name: string) { this.cleared = name; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(value: any) { this.body = value; return this; }, send(value: any) { this.body = value; return this; },
    redirect(value: string) { this.redirected = value; return this; },
  };
}
function manager(): AuthManager {
  const oldId = process.env.IFOOD_CLIENT_ID; const oldSecret = process.env.IFOOD_CLIENT_SECRET;
  process.env.IFOOD_CLIENT_ID = 'fixture-client'; process.env.IFOOD_CLIENT_SECRET = 'fixture-secret';
  const auth = new AuthManager();
  if (oldId === undefined) delete process.env.IFOOD_CLIENT_ID; else process.env.IFOOD_CLIENT_ID = oldId;
  if (oldSecret === undefined) delete process.env.IFOOD_CLIENT_SECRET; else process.env.IFOOD_CLIENT_SECRET = oldSecret;
  return auth;
}
function session(auth: AuthManager): AuthSession {
  const res = response(); auth.middleware({ headers: {} } as any, res, () => undefined); return res.locals.session;
}

test('OAuth uses server-held PKCE/state and rejects mismatched callback before network', async () => {
  const auth = manager(); const previous = session(auth); const oldId = previous.id; const res = response(previous);
  previous.userKey = 'previous-user'; previous.addresses = [{ id: 'old', label: 'Old', formatted: 'Old', latitude: 0, longitude: 0 }];
  auth.start({} as any, res);
  const current = res.locals.session as AuthSession;
  const url = new URL(res.redirected);
  assert.equal(url.origin, 'https://id.ifood.com.br'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok((url.searchParams.get('state')?.length || 0) >= 43); assert.ok(url.searchParams.get('nonce'));
  assert.equal(url.searchParams.has('client_secret'), false); assert.equal(url.searchParams.has('code_verifier'), false);
  assert.notEqual(current.id, oldId); assert.equal(current.userKey, undefined); assert.deepEqual(current.addresses, []); assert.equal(previous.userKey, 'previous-user');
  assert.equal(res.cookies.at(-1).options.httpOnly, true); assert.equal(res.cookies.at(-1).options.sameSite, 'lax');
  await auth.callback({ query: { code: 'unused', state: 'wrong' } } as any, res);
  assert.equal(res.statusCode, 403); assert.equal(current.tokens, undefined);
});

test('OAuth verifies identity, exchanges PKCE, rotates tokens once for concurrent requests, and revokes logout', async () => {
  const auth = manager(); const res = response(session(auth));
  auth.start({} as any, res); const url = new URL(res.redirected); const beforeCallback = res.locals.session.id;
  const { privateKey, publicKey } = await generateKeyPair('RS512');
  const jwk = { ...await exportJWK(publicKey), kid: 'fixture-key', alg: 'RS512', use: 'sig' };
  const idToken = await new SignJWT({ nonce: url.searchParams.get('nonce') }).setProtectedHeader({ alg: 'RS512', kid: 'fixture-key' })
    .setIssuer('https://id.ifood.com.br/3p').setAudience('fixture-client').setSubject('fixture-consumer').setIssuedAt().setExpirationTime('1h').sign(privateKey);
  const originalFetch = globalThis.fetch; const forms: URLSearchParams[] = [];
  globalThis.fetch = (async (target: any, init: any) => {
    if (String(target).includes('jwks.json')) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json' } });
    const form = new URLSearchParams(init?.body); forms.push(form);
    if (String(target).endsWith('/revoke')) return new Response('{}');
    return new Response(JSON.stringify({ access_token: form.get('grant_type') === 'refresh_token' ? 'rotated-access' : 'initial-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'Bearer', id_token: idToken }));
  }) as typeof fetch;
  try {
    await auth.callback({ query: { code: 'fixture-code', state: url.searchParams.get('state') } } as any, res);
    const current = res.locals.session as AuthSession;
    assert.equal(res.redirected, '/?ifood=connected'); assert.notEqual(current.id, beforeCallback);
    assert.equal(current.tokens?.accessToken, 'initial-access'); assert.ok(current.userKey);
    assert.equal(current.userKey, createHash('sha256').update('ifood:fixture-consumer').digest('hex'));
    assert.equal(createHash('sha256').update(forms[0].get('code_verifier')!).digest('base64url'), url.searchParams.get('code_challenge'));
    current.tokens!.expiresAt = Date.now() + 10;
    assert.deepEqual(await Promise.all([auth.accessToken(current), auth.accessToken(current), auth.accessToken(current)]), ['rotated-access', 'rotated-access', 'rotated-access']);
    assert.equal(forms.filter(form => form.get('grant_type') === 'refresh_token').length, 1);
    await auth.logout({} as any, res);
    assert.equal(current.tokens, undefined); assert.equal(res.cleared, 'viu_pediu_session'); assert.equal(forms.at(-1)?.get('token'), 'rotated-refresh');
    assert.equal(JSON.stringify(res.body).includes('access'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('expired session without refresh token clears authentication', async () => {
  const auth = manager(); const current = session(auth);
  current.tokens = { accessToken: 'expired', expiresAt: Date.now() - 1 };
  await assert.rejects(auth.accessToken(current), (error: any) => error.code === 'AUTH_REQUIRED');
  assert.equal(current.tokens, undefined);
});

test('MCP envelopes reject nested HTTP-200 domain errors and accept empty error collections', () => {
  const success = { results: [], errors: [] };
  assert.deepEqual(unwrapToolResult({ content: [{ type: 'text', text: JSON.stringify(success) }] }), success);
  assert.deepEqual(unwrapToolResult({ structuredContent: { response: { data: { results: [], errors: {} } } } }), { data: { results: [], errors: {} } });
  assert.throws(() => unwrapToolResult({ structuredContent: { response: { data: { errors: [{ code: 'MISSING_LOCATION', message: 'Selecione endereço.' }] } } } }), (error: any) => error.code === 'MISSING_LOCATION');
  assert.throws(() => unwrapToolResult({ content: [{ type: 'text', text: '{"error":{"code":"CONSENT_REQUIRED","userFriendlyMessage":"Confirme primeiro."}}' }] }), /Confirme primeiro/);
});

test('gateway validates discovered schemas before calls and does not retry provider failures', async () => {
  let invocations = 0;
  const current: AuthSession = { id: 'fixture', addresses: [], capabilities: [] };
  const gateway = new IfoodGateway({ accessToken: async () => 'fixture-token' } as any, current);
  Object.assign(gateway as any, { token: 'fixture-token', client: {
    listTools: async () => ({ tools: [{ name: 'getItem', inputSchema: { type: 'object', required: ['itemId', 'merchantId'], properties: { itemId: { type: 'string' }, merchantId: { type: 'string' } } } }, { name: 'arbitraryRemoteTool', inputSchema: { type: 'object' } }] }),
    callTool: async () => { invocations++; throw new Error('Timeout'); },
  } });
  assert.deepEqual((await gateway.listTools()).map(tool => tool.name), ['getItem']);
  await assert.rejects(gateway.call('getItem', { itemId: 'item' }), (error: any) => error.code === 'TOOL_ARGUMENTS_INVALID');
  assert.equal(invocations, 0);
  await assert.rejects(gateway.call('getItem', { itemId: 'item', merchantId: 'merchant' }), (error: any) => error.code === 'MCP_REQUEST_FAILED');
  assert.equal(invocations, 1);
  await assert.rejects(gateway.call('arbitraryRemoteTool', {}), (error: any) => error.code === 'TOOL_NOT_ALLOWED');
});

test('normalizers preserve official coordinates, decimal totals, product identifiers and required options', () => {
  assert.deepEqual(normalizeAddresses({ response: { data: { results: [{ addressId: 'address', alias: 'Casa', formattedAddress: 'Rua A, 10', coordinates: { latitude: -22.88, longitude: -46.97 } }, { addressId: 'missing-geo' }] } } }), [{ id: 'address', label: 'Casa', formatted: 'Rua A, 10', latitude: -22.88, longitude: -46.97 }]);
  const offers = normalizeOffers({ response: { merchantType: 'PETSTORE', results: [{ merchantId: 'merchant', merchantName: 'Loja', itemId: 'item', itemName: 'Ração', unitPrice: 25, promotionalUnitPrice: 0, deliveryMethod: { fee: 5, promotionalFee: 0, estimatedMinutes: { min: 20, max: 30 } } }] } });
  assert.equal(offers[0].price, 0); assert.equal(offers[0].deliveryFee, 0); assert.equal(offers[0].merchantType, 'PETSTORE'); assert.equal(offers[0].id, 'merchant:item');
  const items = normalizeItems({ response: { merchantId: 'merchant', itemId: 'item', itemName: 'Ração', unitPrice: 25, optionGroups: [{ optionGroupId: 'group', name: 'Peso', minSelections: 1, maxSelections: 1, options: [{ optionId: 'option', name: '1 kg', additionalPrice: 2 }] }] } }, 'merchant');
  assert.equal(items[0].optionGroups[0].min, 1); assert.equal(items[0].optionGroups[0].options[0].id, 'option');
  assert.throws(() => normalizeItems({ merchantId: 'merchant', itemId: 'item', itemName: 'Produto', optionGroups: [{ optionGroupId: 'required', name: 'Obrigatório', options: [] }] }, 'merchant'), (error: any) => error.code === 'INVALID_ITEM_OPTIONS');
  assert.deepEqual(normalizeOffers({ results: [{ name: 'Produto sem identificadores' }] }), []);
});

test('agent exposes only reads, preserves signatures/IDs and uses only gateway offers', async () => {
  const calls: any[] = []; const offers: any[] = []; const requests: any[] = [];
  const gateway: ToolGateway = {
    listTools: async () => ['searchOffers', 'submitOrder', 'createCart', 'getItem'].map(name => ({ name, inputSchema: { type: 'object' } })),
    call: async (name, args) => { calls.push({ name, args }); return { results: [{ merchantId: 'merchant', merchantName: 'Loja', itemId: 'item', itemName: 'Produto', unitPrice: 9.9 }] }; },
  };
  const modelContent = { role: 'model', parts: [{ thoughtSignature: 'signature-fixture', functionCall: { id: 'lookup-1', name: 'searchOffers', args: { query: 'produto', userLocation: { latitude: 80, longitude: 100 } } } }, { functionCall: { id: 'forbidden-1', name: 'submitOrder', args: {} } }] };
  const result = await runAgent({ gateway, text: 'Busque produto', history: [], location: { latitude: -23, longitude: -46 }, merchantType: 'DRUGSTORE', sort: 'PRICE', onProgress: () => undefined, onOffers: items => { offers.push(...items); } }, {
    models: { generateContent: async request => { requests.push(request); return requests.length === 1 ? { candidates: [{ content: modelContent }] } : { candidates: [{ content: { role: 'model', parts: [{ text: 'Encontrei uma oferta.' }] } }], text: 'Encontrei uma oferta.' }; } },
  });
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'searchOffers'); assert.deepEqual(calls[0].args.userLocation, { latitude: -23, longitude: -46 });
  assert.equal(calls[0].args.merchantType, 'DRUGSTORE'); assert.equal(calls[0].args.refinements.sort, 'PRICE'); assert.equal(offers[0].itemId, 'item');
  for (const declaration of requests[0].config.tools[0].functionDeclarations) assert.equal(AGENT_READ_TOOLS.has(declaration.name), true);
  assert.equal(result.history[1], modelContent); assert.equal(result.history[2].parts[0].functionResponse.id, 'lookup-1'); assert.equal(result.history[2].parts[1].functionResponse.id, 'forbidden-1');
});

test('agent has an eight-call execution ceiling even when model keeps requesting tools', async () => {
  let calls = 0;
  const gateway: ToolGateway = { listTools: async () => [{ name: 'listAddresses', inputSchema: { type: 'object' } }], call: async () => { calls++; return { results: [] }; } };
  await runAgent({ gateway, text: 'Procure', history: [], onProgress: () => undefined, onOffers: () => undefined }, {
    models: { generateContent: async () => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'listAddresses', args: {} } }] } }] }) },
  });
  assert.equal(calls, 8);
});

test('internal cart preparation is gated by explicit intent and never exposes upstream mutations', async () => {
  const sourceOffer = { merchantId: 'merchant', merchantName: 'Loja', itemId: 'item', itemName: 'Produto' };
  const history = [{ role: 'user', parts: [{ functionResponse: { name: 'searchOffers', response: { result: { results: [sourceOffer] } } } }] }];
  const gateway: ToolGateway = { listTools: async () => ['searchOffers', 'submitOrder', 'setCartPayment', 'createCart'].map(name => ({ name, inputSchema: { type: 'object' } })), call: async () => { throw new Error('No upstream calls expected'); } };
  let prepared = 0;
  for (const [text, expected] of [['Busque esse produto', false], ['\nAnálise da imagem (somente evidências visíveis): {}. Procure opções.', false], ['Não quero comprar, só pesquisar', false], ['Coloca esse item no carrinho', true]] as const) {
    let generation = 0;
    await runAgent({ gateway, text, history, onProgress: () => undefined, onOffers: () => undefined,
      onPrepareCart: async args => { prepared++; assert.equal(args.offerId, 'merchant:item'); assert.equal(args.itemId, 'item'); return { id: 'review', ready: false } as any; },
    }, { models: { generateContent: async request => {
      if (generation++ === 0) {
        const names = request.config.tools[0].functionDeclarations.map((tool: any) => tool.name);
        assert.equal(names.includes('prepareCart'), expected);
        for (const unsafe of ['createCart', 'submitOrder', 'setCartPayment']) assert.equal(names.includes(unsafe), false);
        return { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'prepareCart', args: { offerId: 'merchant:item', quantity: 1, options: [] } } }] } }] };
      }
      return { candidates: [{ content: { role: 'model', parts: [{ text: 'Consulte a revisão.' }] } }], text: 'Consulte a revisão.' };
    } } });
  }
  assert.equal(prepared, 1);
});

test('internal preparation rejects fabricated offer IDs before invoking deterministic checkout', async () => {
  let prepared = false; let generation = 0;
  const gateway: ToolGateway = { listTools: async () => [], call: async () => { throw new Error('No upstream calls expected'); } };
  const result = await runAgent({ gateway, text: 'Quero comprar esse produto', history: [], onProgress: () => undefined, onOffers: () => undefined,
    onPrepareCart: async () => { prepared = true; return {} as any; },
  }, { models: { generateContent: async () => generation++ === 0
    ? { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'prepareCart', args: { offerId: 'invented:item' } } }] } }] }
    : { candidates: [{ content: { role: 'model', parts: [{ text: 'Primeiro precisamos pesquisar.' }] } }], text: 'Primeiro precisamos pesquisar.' },
  } });
  assert.equal(prepared, false); assert.ok(result.history[2].parts[0].functionResponse.response.result.error);
});
