import { expect, test, type Page } from '@playwright/test';
import type { Address, CartReview, Conversation, ItemDetails, Offer, OrderReceipt, SessionState } from '../shared/types';

// Fixtures live only inside this browser test. Every API request is intercepted;
// no OAuth, Gemini, iFood cart or order endpoint is contacted by these scenarios.
const PHOTO = {
  name: 'produto.png', mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6UZ8AAAAASUVORK5CYII=', 'base64'),
};
const address: Address = { id: 'fixture-address', label: 'Casa', formatted: 'Rua das Flores, 100, Centro, São Carlos - SP', latitude: -22.01, longitude: -47.89 };
const offer: Offer = { id: 'fixture-merchant:fixture-item', merchantId: 'fixture-merchant', itemId: 'fixture-item', merchantName: 'Mercado do Bairro', name: 'Biscoito de chocolate 120 g', price: 12.9, deliveryFee: 4.9, deliveryMinutes: 30, deliveryLabel: '20–30 min', merchantType: 'GROCERIES', minimumOrder: 10 };
const item: ItemDetails = { merchantId: offer.merchantId, itemId: offer.itemId!, name: offer.name, price: offer.price,
  optionGroups: [{ id: 'fixture-group', name: 'Embalagem', min: 1, max: 1, options: [{ id: 'fixture-option', name: 'Caixa de 120 g', price: 0 }] }],
};
const emptyConversation = (): Conversation => ({ id: 'fixture-conversation', messages: [], offers: [] });
const foundConversation = (quote?: Offer['quote']): Conversation => ({
  ...emptyConversation(),
  messages: [
    { id: 'fixture-user', role: 'user', text: 'Encontre o produto da minha foto.', imageName: PHOTO.name, createdAt: '2026-10-18T14:00:00.000Z' },
    { id: 'fixture-agent', role: 'assistant', text: 'Encontrei esta opção perto de você. Confira a embalagem antes de preparar sua sacola.', createdAt: '2026-10-18T14:00:01.000Z' },
  ],
  vision: { productName: offer.name, details: 'Embalagem de biscoito de chocolate.', searchQueries: ['biscoito de chocolate 120 g'], needsClarification: false },
  offers: [{ ...offer, ...(quote ? { quote } : {}) }],
});

async function offlineApi(page: Page, options: { found?: boolean; failConfirmation?: boolean; quote?: Offer['quote'] } = {}) {
  let conversation = options.found ? foundConversation(options.quote) : emptyConversation();
  let version = 0;
  const chatRequests: any[] = [], reviewRequests: any[] = [], confirmRequests: any[] = [], unexpected: string[] = [], orderRequests: string[] = [];
  const session: SessionState = { connected: true, configured: true, geminiConfigured: true, userName: 'Marina', addresses: [address], selectedAddressId: address.id, orders: [], capabilities: ['getItem', 'searchOffers', 'createCart', 'submitOrder'] };
  const receipt: OrderReceipt = { id: 'fixture-order', cartId: 'fixture-cart', merchantName: offer.merchantName, total: 17.8, createdAt: '2026-10-18T14:01:00.000Z', retryAfterSeconds: 3, pollingStop: false };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/session' && request.method() === 'GET') return json(session);
    if (path === '/api/chat' && request.method() === 'GET') return json(conversation);
    if (path === '/api/chat/new' && request.method() === 'POST') { conversation = emptyConversation(); return json(conversation); }
    if (path === '/api/chat' && request.method() === 'POST') {
      chatRequests.push(request.postDataJSON()); conversation = foundConversation(options.quote);
      const stream = [
        { type: 'progress', text: 'Conferindo os detalhes da sua foto…' },
        { type: 'state', conversation },
        { type: 'done' },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: stream });
    }
    if (path === '/api/items' && request.method() === 'GET') return json({ items: [item] });
    if (path === '/api/checkout/review' && request.method() === 'POST') {
      const body = request.postDataJSON(); reviewRequests.push(body); version++;
      const deliveryMethodId = body.deliveryMethodId ?? conversation.review?.deliveryMethodId;
      const review: CartReview = {
        id: 'fixture-review', version, cartId: receipt.cartId, merchantId: offer.merchantId, merchantName: offer.merchantName, address,
        items: [{ itemId: item.itemId, cartItemId: 'fixture-cart-line', name: item.name, quantity: body.quantity ?? 1, options: body.options ?? conversation.review?.items[0].options ?? [], price: item.price, total: item.price }],
        deliveryMethods: [{ id: 'DEFAULT', name: 'Entrega padrão', fee: 4.9, description: '20–30 min' }], deliveryMethodId,
        paymentMethodId: 'fixture-pix-method', paymentKind: 'PIX', vouchers: [],
        totals: { subtotal: 12.9, deliveryFee: 4.9, serviceFee: 0, discount: 0, total: 17.8, minimumOrder: 10 },
        blockers: deliveryMethodId ? [] : ['Escolha uma opção de entrega.'], ready: Boolean(deliveryMethodId),
      };
      conversation = { ...conversation, review }; return json(review);
    }
    if (path === '/api/checkout/confirm' && request.method() === 'POST') {
      confirmRequests.push(request.postDataJSON());
      if (options.failConfirmation) return json({ message: 'Não foi possível confirmar o resultado do envio. Confira sua conta iFood.', code: 'ORDER_UNKNOWN' }, 409);
      session.orders = [receipt]; conversation = { ...conversation, review: undefined }; return json(receipt);
    }
    if (path === '/api/orders/fixture-order' && request.method() === 'GET') {
      orderRequests.push(path); return json({ ...receipt, status: { code: 'ORDER_CREATED', description: 'Pedido criado no iFood' }, pollingStop: true });
    }
    unexpected.push(`${request.method()} ${path}`);
    return json({ error: 'API não prevista na fixture offline.', code: 'UNEXPECTED_OFFLINE_API' }, 501);
  });
  return { chatRequests, reviewRequests, confirmRequests, orderRequests, unexpected };
}

async function prepareReview(page: Page) {
  await page.getByRole('region', { name: 'Opções encontradas' }).getByRole('button', { name: 'Comprar', exact: true }).click();
  const itemDialog = page.getByRole('dialog', { name: item.name });
  await expect(itemDialog).toBeVisible();
  await expect(itemDialog.getByText('Obrigatório', { exact: true })).toBeVisible();
  await expect(itemDialog.getByRole('button', { name: 'Revisar pedido' })).toBeDisabled();
  await itemDialog.getByRole('button', { name: 'Adicionar Caixa de 120 g', exact: true }).click();
  await expect(itemDialog.getByRole('button', { name: 'Revisar pedido' })).toBeEnabled();
  await itemDialog.getByRole('button', { name: 'Revisar pedido' }).click();
  const reviewDialog = page.getByRole('dialog', { name: 'Quase na sua porta' });
  await expect(reviewDialog).toBeVisible();
  await expect(reviewDialog.getByText('Pix', { exact: true })).toBeVisible();
  await expect(reviewDialog.getByRole('button', { name: 'Confirmar e enviar ao iFood' })).toBeDisabled();
  await expect(reviewDialog.getByRole('checkbox')).toBeDisabled();
  const delivery = reviewDialog.getByRole('radio', { name: /Entrega padrão/ });
  await delivery.click();
  await expect(delivery).toBeChecked();
  await expect(reviewDialog.getByRole('checkbox')).toBeEnabled();
  await expect(reviewDialog.getByRole('button', { name: 'Confirmar e enviar ao iFood' })).toBeDisabled();
  return reviewDialog;
}

test('foto → ofertas SSE → opção obrigatória → entrega e Pix → consentimento → recibo', async ({ page }) => {
  const api = await offlineApi(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Abrir câmera', exact: true })).toBeEnabled();
  await page.getByLabel('Enviar foto', { exact: true }).setInputFiles(PHOTO);
  await expect(page.getByRole('textbox', { name: 'Sua mensagem' })).toBeVisible();
  await expect(page.getByRole('img', { name: `Foto enviada: ${PHOTO.name}` })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Opções encontradas' })).toContainText(offer.merchantName);
  expect(api.chatRequests).toHaveLength(1);
  expect(api.chatRequests[0]).toMatchObject({ conversationId: 'fixture-conversation', mimeType: 'image/png', imageName: PHOTO.name });
  expect(api.chatRequests[0].imageBase64).toBe(PHOTO.buffer.toString('base64'));
  const review = await prepareReview(page);
  await expect(review.getByText(address.formatted)).toBeVisible();
  expect(api.reviewRequests[0]).toMatchObject({ offerId: offer.id, itemId: item.itemId, quantity: 1, options: [{ groupId: 'fixture-group', optionId: 'fixture-option', quantity: 1 }] });
  await review.getByRole('checkbox', { name: /Conferi os itens/ }).check();
  await review.getByRole('button', { name: 'Confirmar e enviar ao iFood' }).click();
  const receipt = page.getByRole('dialog', { name: 'Sua vontade virou pedido' });
  await expect(receipt).toBeVisible(); await expect(receipt.getByText('fixture-order', { exact: true })).toBeVisible();
  expect(api.confirmRequests).toEqual([{ conversationId: 'fixture-conversation', reviewId: 'fixture-review', version: 2, userConsent: true }]);
  expect(api.confirmRequests[0]).not.toHaveProperty('paymentMethodId'); expect(api.confirmRequests[0]).not.toHaveProperty('cardTokenId');
  await expect.poll(() => api.orderRequests.length).toBe(1);
  await expect(receipt.getByRole('heading', { name: 'Pedido criado no iFood' })).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test('falha de envio mantém revisão, não cria recibo e impede novo envio incerto', async ({ page }) => {
  const api = await offlineApi(page, { found: true, failConfirmation: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const review = await prepareReview(page);
  await review.getByRole('checkbox').check(); await review.getByRole('button', { name: 'Confirmar e enviar ao iFood' }).click();
  await expect(review.getByRole('alert')).toContainText('Não foi possível confirmar o resultado');
  await expect(page.getByRole('dialog', { name: 'Sua vontade virou pedido' })).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Confirmar e enviar ao iFood' })).toBeDisabled();
  await expect(review.getByText(/Esta sacola não será enviada de novo/)).toBeVisible();
  await review.getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.getByRole('button', { name: /Sua sacola/ }).click();
  await expect(page.getByRole('dialog', { name: 'Quase na sua porta' }).getByRole('button', { name: 'Confirmar e enviar ao iFood' })).toBeDisabled();
  expect(api.confirmRequests).toHaveLength(1); expect(api.unexpected).toEqual([]);
});

test('arquivo em formato inválido mostra erro sem enviar imagem', async ({ page }) => {
  const api = await offlineApi(page);
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Abrir câmera', exact: true })).toBeEnabled();
  await page.getByLabel('Enviar foto', { exact: true }).setInputFiles({ name: 'documento.txt', mimeType: 'text/plain', buffer: Buffer.from('não é uma imagem') });
  await expect(page.getByRole('alert')).toContainText('Escolha uma imagem JPG, PNG ou WEBP.');
  expect(api.chatRequests).toHaveLength(0); expect(api.confirmRequests).toHaveLength(0); expect(api.unexpected).toEqual([]);
});

test('cartão mostra total cotado pelo iFood com taxas, cupom e prazo, antes da revisão', async ({ page }) => {
  const api = await offlineApi(page, { found: true, quote: {
    status: 'ready', addressId: address.id, quotedAt: '2026-10-18T14:00:02.000Z', quotedTotal: 15.7,
    totals: { subtotal: 12.9, deliveryFee: 4.9, serviceFee: 0.9, voucherDiscount: 3, total: 15.7, minimumOrder: 10 },
    availableVouchers: [{ code: 'FOTO3', campaignId: 'fixture-campaign', title: 'R$ 3 de desconto' }],
    appliedVoucher: { code: 'FOTO3', campaignId: 'fixture-campaign', title: 'R$ 3 de desconto' },
    delivery: { id: 'DEFAULT', name: 'Entrega padrão', fee: 4.9, description: '20–30 min' }, blockers: [],
  } });
  await page.goto('/'); await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const offers = page.getByRole('region', { name: 'Opções encontradas' });
  await expect(offers).toContainText('Total com taxas');
  await expect(offers).toContainText(/R\$\s*15,70/);
  await expect(offers).toContainText(/R\$\s*12,90/);
  await expect(offers).toContainText('FOTO3');
  await expect(offers).toContainText('20–30 min');
  expect(api.reviewRequests).toHaveLength(0); expect(api.confirmRequests).toHaveLength(0); expect(api.unexpected).toEqual([]);
});

test('permissão de câmera negada mostra alternativa e bloqueia captura', async ({ page }) => {
  const api = await offlineApi(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException('Permissão negada', 'NotAllowedError')) } });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Abrir câmera', exact: true }).click();
  const camera = page.getByRole('region', { name: 'Câmera' });
  await expect(camera.getByText(/Não foi possível abrir a câmera/)).toBeVisible();
  await expect(camera.getByRole('button', { name: 'Fotografar', exact: true })).toBeDisabled();
  await expect(camera.getByRole('button', { name: 'Enviar foto da galeria', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Início', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Abrir câmera', exact: true })).toBeVisible();
  expect(api.chatRequests).toHaveLength(0); expect(api.unexpected).toEqual([]);
});

for (const width of [360, 768, 1440]) {
  test(`layout e revisão sem rolagem horizontal em ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await offlineApi(page, { found: true });
    await page.goto('/');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Opções encontradas' })).toBeVisible();
    const dimensions = () => page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    expect((await dimensions()).document).toBeLessThanOrEqual(width + 1);
    expect((await dimensions()).body).toBeLessThanOrEqual(width + 1);
    const review = await prepareReview(page);
    await expect(review).toBeVisible();
    expect((await dimensions()).document).toBeLessThanOrEqual(width + 1);
    const bounds = await review.boundingBox(), frame = await page.locator('.app-shell').boundingBox(); expect(bounds).toBeTruthy(); expect(frame).toBeTruthy();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    expect(bounds!.x).toBeGreaterThanOrEqual(frame!.x); expect(bounds!.y).toBeGreaterThanOrEqual(frame!.y);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 1);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 1);
    expect(api.confirmRequests).toHaveLength(0); expect(api.unexpected).toEqual([]);
  });
}
