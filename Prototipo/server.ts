import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { AuthManager, type AuthSession } from './server/auth.ts';
import { IfoodGateway, normalizeAddresses } from './server/ifood.ts';
import { runAgent } from './server/agent.ts';
import { analyzeImage } from './server/vision.ts';
import { AppError, assert, messageOf } from './server/errors.ts';
import { publicConversation, SerialLocks, Store } from './server/store.ts';
import { CheckoutService } from './server/checkout.ts';
import { adoptOfferQuote, curateOffers, quoteOffers } from './server/curation.ts';
import type { Address, ChatEvent, MerchantType, SessionState } from './shared/types.ts';

const directory = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: [path.join(directory, '.env'), path.join(directory, '.env.local'), path.join(directory, '../.env')], quiet: true });
const PORT = Number(process.env.PORT) || 3000;
const auth = new AuthManager();
const store = new Store(process.env.DATABASE_PATH || path.join(directory, 'data/viu-pediu.sqlite'));
const checkout = new CheckoutService(store);
const locks = new SerialLocks();
const gateways = new WeakMap<AuthSession, IfoodGateway>();
const gatewayBindings = new WeakMap<AuthSession, string>();
const initialized = new WeakMap<AuthSession, string>();
const nextPoll = new Map<string, number>();
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '15mb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    const allowed = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
    if (process.env.APP_URL) { try { allowed.add(new URL(process.env.APP_URL).origin); } catch { /* ignore invalid optional URL */ } }
    if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && !allowed.has(origin))) {
      res.status(403).json({ error: 'Origem da solicitação não autorizada.', code: 'INVALID_ORIGIN' }); return;
    }
  }
  next();
});
app.use('/api', auth.middleware);
const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve(fn(req, res)).catch(next); };
const sessionOf = (res: Response) => res.locals.session as AuthSession;
const ownerOf = (session: AuthSession) => session.userKey || session.id;
const bodyOf = (v: any) => v?.response ?? v?.data ?? v;
const gatewayOf = (session: AuthSession) => {
  let gateway = gateways.get(session);
  if (!gateway || gatewayBindings.get(session) !== session.id) {
    void gateway?.close().catch(() => undefined);
    gateway = new IfoodGateway(auth, session); gateways.set(session, gateway); gatewayBindings.set(session, session.id);
  }
  return gateway;
};
async function connectSession(session: AuthSession) {
  assert(session.tokens, 'Conecte sua conta iFood para continuar.', 401, 'AUTHENTICATION_REQUIRED');
  const gateway = gatewayOf(session);
  await auth.accessToken(session);
  if (initialized.get(session) !== (session.userKey || session.id)) {
    session.capabilities = (await gateway.listTools()).map(t => t.name);
    if (session.capabilities.includes('getUser')) {
      const profile = bodyOf(await gateway.call('getUser', {}));
      session.userName = profile?.fullName ?? profile?.name ?? profile?.user?.name ?? profile?.profile?.name;
      const identity = typeof profile?.email === 'string' ? `email:${profile.email.trim().toLowerCase()}` : typeof profile?.phone === 'string' ? `phone:${profile.phone.replace(/\D/g, '')}` : undefined;
      if ((!session.userKey || session.userKey === session.id) && identity) session.userKey = createHash('sha256').update(`ifood-authenticated-profile:${identity}`).digest('hex');
    }
    session.addresses = normalizeAddresses(await gateway.call('listAddresses', {}));
    if (!session.addresses.some(a => a.id === session.selectedAddressId)) session.selectedAddressId = session.addresses.length === 1 ? session.addresses[0].id : undefined;
    initialized.set(session, session.userKey || session.id);
  }
  return gateway;
}
function addressOf(session: AuthSession): Address {
  const address = session.addresses.find(a => a.id === session.selectedAddressId);
  assert(address, 'Escolha um endereço de entrega antes de pesquisar.', 409, 'ADDRESS_REQUIRED');
  return address;
}
function stateOf(session: AuthSession): SessionState {
  return { connected: Boolean(session.tokens), configured: auth.configured, geminiConfigured: Boolean(process.env.GEMINI_API_KEY && !/^(YOUR_|MY_|COLOQUE_)/.test(process.env.GEMINI_API_KEY)), userName: session.userName, addresses: session.addresses, selectedAddressId: session.selectedAddressId, orders: session.tokens ? store.orders(ownerOf(session)) : [], capabilities: session.capabilities };
}

app.get('/api/auth/ifood/start', auth.start);
app.get('/api/auth/ifood/callback', asyncRoute(auth.callback));
app.post('/api/auth/ifood/logout', asyncRoute(async (req, res) => {
  const session = sessionOf(res);
  await gateways.get(session)?.close().catch(() => undefined);
  gateways.delete(session); initialized.delete(session);
  await auth.logout(req, res);
}));
app.get('/api/session', asyncRoute(async (_req, res) => {
  const session = sessionOf(res);
  if (session.tokens) await connectSession(session);
  res.json(stateOf(session));
}));
app.post('/api/session/address', asyncRoute(async (req, res) => {
  const session = sessionOf(res); const gateway = await connectSession(session);
  if (typeof req.body.addressId === 'string') {
    assert(session.addresses.some(a => a.id === req.body.addressId), 'Endereço não encontrado na sua conta.');
    session.selectedAddressId = req.body.addressId;
  } else {
    assert(typeof req.body.address === 'string' && req.body.address.trim().length >= 5 && req.body.address.length <= 500, 'Informe um endereço completo.');
    const args: Record<string, unknown> = { address: req.body.address.trim() };
    for (const key of ['complement', 'candidateId', 'neighborhood', 'reference', 'alias']) if (typeof req.body[key] === 'string' && req.body[key].length <= 300) args[key] = req.body[key];
    const result = bodyOf(await gateway.call('createAddress', args));
    const candidates = result?.candidates ?? result?.geocoding?.candidates;
    if (Array.isArray(candidates) && candidates.length && !result.addressId) {
      res.json({ candidates: candidates.map((c: any) => ({ id: c.candidateId ?? c.id, label: c.formattedAddress ?? c.description ?? c.label, formatted: c.formattedAddress ?? c.description ?? c.label })) }); return;
    }
    session.addresses = normalizeAddresses(await gateway.call('listAddresses', {}));
    const createdId = result?.addressId ?? result?.address?.addressId;
    session.selectedAddressId = session.addresses.find(a => a.id === createdId)?.id;
    if (!session.selectedAddressId && session.addresses.length === 1) session.selectedAddressId = session.addresses[0].id;
  }
  res.json(stateOf(session));
}));
app.get('/api/chat', asyncRoute(async (req, res) => {
  const session = sessionOf(res);
  res.json(publicConversation(store.conversation(ownerOf(session), typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined)));
}));
app.post('/api/chat/new', asyncRoute(async (_req, res) => { res.json(publicConversation(store.createConversation(ownerOf(sessionOf(res))))); }));
app.post('/api/chat', asyncRoute(async (req, res) => {
  const session = sessionOf(res); const gateway = await connectSession(session); const address = addressOf(session);
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  assert(text.length <= 6000, 'Envie uma mensagem de até 6.000 caracteres.');
  const image = req.body.imageBase64;
  assert(text || typeof image === 'string' || req.body.sort, 'Envie uma imagem ou escreva o que procura.');
  assert(!image || typeof image === 'string', 'Imagem inválida.');
  let record = store.conversation(ownerOf(session), req.body.conversationId);
  await locks.run(`${ownerOf(session)}:${record.id}`, async () => {
    record = store.conversation(ownerOf(session), record.id);
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const event = (data: ChatEvent) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };
    const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n'); }, 15_000);
    try {
      record.messages.push({ id: randomUUID(), role: 'user', text: text || (image ? 'Encontrei isso. Você encontra no iFood?' : 'Atualizar ordenação da busca'), createdAt: new Date().toISOString(), imageName: image ? String(req.body.imageName || 'Imagem enviada').slice(0, 150) : undefined });
      store.saveConversation(ownerOf(session), record);
      event({ type: 'state', conversation: publicConversation(record) });
      let agentText = text;
      if (image) {
        event({ type: 'progress', text: 'Olhando sua imagem…' });
        record.vision = await analyzeImage({ imageBase64: image, mimeType: req.body.mimeType, imageName: req.body.imageName });
        record.offers = [];
        event({ type: 'state', conversation: publicConversation(record) });
        agentText = `${text}\nAnálise da imagem (somente evidências visíveis): ${JSON.stringify(record.vision)}. Procure as opções compatíveis no iFood usando os termos sugeridos.`;
        if (record.vision.needsClarification) {
          record.messages.push({ id: randomUUID(), role: 'assistant', text: `${record.vision.details || 'Não consegui identificar um único produto com segurança.'} Qual item você quer encontrar?`, createdAt: new Date().toISOString() });
          record.history.push({ role: 'user', parts: [{ text: agentText }] });
          store.saveConversation(ownerOf(session), record);
          event({ type: 'state', conversation: publicConversation(record) }); return;
        }
      }
      if (!agentText) agentText = `Refaça a última busca desta conversa preservando o produto, as correções e as restrições mais recentes do usuário. Ordenação: ${req.body.sort || 'RELEVANCE'}.`;
      let foundOffers = false;
      const result = await runAgent({ gateway, text: agentText, history: record.history, location: { latitude: address.latitude, longitude: address.longitude }, sort: req.body.sort, merchantType: req.body.merchantType as MerchantType,
        onProgress: text => event({ type: 'progress', text }),
        onOffers: offers => { foundOffers = true; record.offers = curateOffers(offers, req.body.sort); event({ type: 'state', conversation: publicConversation(record) }); },
        onPrepareCart: async args => {
          const offer = record.offers.find(o => o.id === args.offerId);
          assert(offer, 'Selecione uma oferta disponível para preparar o carrinho.');
          const itemId = args.itemId ?? offer.itemId;
          assert(itemId, 'Escolha um item do cardápio antes de preparar o carrinho.');
          adoptOfferQuote({ record, offerId: offer.id, address, owner: ownerOf(session), store });
          if (!record.itemCache[itemId]) await checkout.loadItems(gateway, record, offer.id, address);
          const line = record.review?.items.find(i => i.itemId === itemId);
          const review = await checkout.review(ownerOf(session), gateway, record, address, { ...args, itemId, conversationId: record.id, addItem: !line, cartItemId: line?.cartItemId });
          event({ type: 'state', conversation: publicConversation(record) });
          return review;
        },
      });
      record.history = result.history;
      record.messages.push({ id: randomUUID(), role: 'assistant', text: result.text, createdAt: new Date().toISOString() });
      if (foundOffers && record.offers.length) {
        await quoteOffers({ owner: ownerOf(session), store, checkout, gateway, record, address,
          onProgress: text => event({ type: 'progress', text }),
          onOffers: () => event({ type: 'state', conversation: publicConversation(record) }),
        });
        record.offers = curateOffers(record.offers, req.body.sort);
      }
      store.saveConversation(ownerOf(session), record);
      event({ type: 'state', conversation: publicConversation(record) });
    } catch (error) {
      record.messages.push({ id: randomUUID(), role: 'system', text: messageOf(error), createdAt: new Date().toISOString() });
      store.saveConversation(ownerOf(session), record);
      event({ type: 'state', conversation: publicConversation(record) });
      event({ type: 'error', message: messageOf(error), code: (error as any)?.code });
    } finally { clearInterval(heartbeat); event({ type: 'done' }); res.end(); }
  });
}));
app.get('/api/items', asyncRoute(async (req, res) => {
  const session = sessionOf(res); const gateway = await connectSession(session);
  assert(typeof req.query.conversationId === 'string' && typeof req.query.offerId === 'string', 'Selecione uma oferta.');
  const record = store.conversation(ownerOf(session), req.query.conversationId);
  const items = await locks.run(`${ownerOf(session)}:${record.id}`, async () => {
    const fresh = store.conversation(ownerOf(session), record.id);
    const items = await checkout.loadItems(gateway, fresh, req.query.offerId as string, addressOf(session));
    store.saveConversation(ownerOf(session), fresh); return items;
  });
  res.json({ items });
}));
app.post('/api/checkout/review', asyncRoute(async (req, res) => {
  const session = sessionOf(res); const gateway = await connectSession(session);
  assert(typeof req.body.conversationId === 'string', 'Conversa inválida.');
  const record = store.conversation(ownerOf(session), req.body.conversationId);
  const review = await locks.run(`${ownerOf(session)}:${record.id}`, () => {
    const fresh = store.conversation(ownerOf(session), record.id);
    const address = addressOf(session);
    const request = { ...req.body };
    if (request.offerId && adoptOfferQuote({ record: fresh, offerId: request.offerId, address, owner: ownerOf(session), store })) {
      const offer = fresh.offers.find(o => o.id === request.offerId);
      const line = fresh.review?.items.find(i => i.itemId === (request.itemId ?? offer?.itemId));
      if (line) { request.addItem = false; request.cartItemId = line.cartItemId; }
    }
    return checkout.review(ownerOf(session), gateway, fresh, address, request);
  });
  res.json(review);
}));
app.post('/api/checkout/confirm', asyncRoute(async (req, res) => {
  assert(Object.keys(req.body).every(k => ['conversationId', 'reviewId', 'version', 'userConsent'].includes(k)), 'Campos de confirmação inválidos.');
  const session = sessionOf(res); const gateway = await connectSession(session);
  assert(typeof req.body.conversationId === 'string', 'Conversa inválida.');
  const record = store.conversation(ownerOf(session), req.body.conversationId);
  const receipt = await locks.run(`${ownerOf(session)}:${record.id}`, () => {
    const fresh = store.conversation(ownerOf(session), record.id);
    assert(!fresh.review || fresh.review.address.id === addressOf(session).id, 'O endereço mudou. Prepare um novo carrinho antes de confirmar.', 409, 'ADDRESS_CHANGED');
    return checkout.confirm(ownerOf(session), gateway, fresh, req.body);
  });
  res.json(receipt);
}));
app.get('/api/orders/:id', asyncRoute(async (req, res) => {
  const session = sessionOf(res); const gateway = await connectSession(session); const owner = ownerOf(session);
  const receipt = store.order(owner, String(req.params.id));
  const pollKey = `${owner}:${receipt.id}`;
  if ((nextPoll.get(pollKey) ?? 0) > Date.now() || (receipt.pollingStop && receipt.details)) { res.json(receipt); return; }
  const results = await Promise.allSettled([
    !receipt.pollingStop ? gateway.call('trackOrder', { orderId: receipt.id }) : Promise.resolve(undefined),
    !receipt.details ? gateway.call('getOrder', { orderId: receipt.id }) : Promise.resolve(receipt.details),
  ]);
  if (results[0].status === 'fulfilled' && results[0].value !== undefined) {
    const tracking = bodyOf(results[0].value);
    if (tracking?.status && typeof tracking.status.code === 'string' && typeof tracking.status.description === 'string') receipt.status = tracking.status;
    const hints = tracking?.agentHints;
    receipt.pollingStop = hints?.pollingStop === true;
    const match = String(hints?.retryMessage || '').match(/(\d+)\s*(seg|sec|s\b|min)/i);
    receipt.retryAfterSeconds = match ? Math.max(5, Number(match[1]) * (/min/i.test(match[2]) ? 60 : 1)) : 30;
    nextPoll.set(pollKey, Date.now() + receipt.retryAfterSeconds * 1000);
  }
  if (results[1].status === 'fulfilled') receipt.details = bodyOf(results[1].value);
  if (results.every(r => r.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason;
  store.saveOrder(owner, receipt); res.json(receipt);
}));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Esta operação não existe.', code: 'NOT_FOUND' }));
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = error.type === 'entity.too.large' ? 413 : Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  const message = status === 413 ? 'A imagem excede o tamanho permitido.' : status === 500 ? 'Não foi possível concluir esta operação. Tente novamente.' : messageOf(error);
  if (!res.headersSent) res.status(status).json({ error: message, message, code: error.code || 'INTERNAL_ERROR', ...(error.extra || {}) });
  else res.end();
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({ configFile: path.join(directory, 'vite.config.ts'), root: directory, server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(directory, 'dist')));
    app.get('*', (_req, res) => res.sendFile(path.join(directory, 'dist/index.html')));
  }
  app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`Viu, pediu. disponível em http://localhost:${PORT}`);
    console.log(`iFood: ${auth.configured ? 'credenciais configuradas' : 'configure IFOOD_CLIENT_ID e IFOOD_CLIENT_SECRET'} | Pix obrigatório | nenhum pedido é enviado ao iniciar`);
  });
}
startServer().catch(error => { console.error('Não foi possível iniciar Viu, pediu.:', messageOf(error)); process.exitCode = 1; });
