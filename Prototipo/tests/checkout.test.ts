import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckoutService, assertPix, cartSnapshot, normalizeReview } from '../server/checkout.ts';
import { Store, publicConversation } from '../server/store.ts';
import type { ToolGateway } from '../server/ifood.ts';
import type { Address, CartReview, ItemDetails } from '../shared/types.ts';

const address: Address = { id: 'address-real', label: 'Casa', formatted: 'Rua de teste, 1', latitude: -22, longitude: -47 };
const item: ItemDetails = { merchantId: 'merchant-real', itemId: 'item-real', name: 'Produto', price: 30, optionGroups: [] };
function fixture() {
  const store = new Store(':memory:');
  const owner = 'consumer-a';
  const record = store.createConversation(owner);
  record.itemCache[item.itemId] = structuredClone(item);
  record.offers = [{ id: 'offer-real', merchantId: item.merchantId, itemId: item.itemId, merchantName: 'Loja', name: item.name }];
  let cart: any = {
    cartId: 'cart-real', merchant: { merchantId: item.merchantId, merchantName: 'Loja', orderMinimumPrice: 20 },
    items: [{ itemId: item.itemId, cartItemId: 'line-real', name: 'Produto', quantity: 1, unitPrice: 30, options: [] }],
    deliveryAddress: { streetName: 'Rua de teste', streetNumber: '1' },
    deliveryMethod: { deliveryMethodName: 'Padrão', fee: 5 },
    paymentMethod: { paymentMethodId: 'pix-real', kind: 'PIX', cardTokenId: null },
    summary: { subtotalAmount: 30, totalAmount: 35, deliveryFeeAmount: 5, feeTotalAmount: 0 },
  };
  const context: CartReview = { id: 'review-real', version: 1, cartId: cart.cartId, merchantId: item.merchantId, merchantName: 'Loja', address, items: [], deliveryMethods: [{ id: 'delivery-real', name: 'Padrão' }], deliveryMethodId: 'delivery-real', paymentMethodId: 'pix-real', paymentKind: 'PIX', vouchers: [], totals: {}, blockers: [], ready: false };
  record.review = normalizeReview(cart, context, record);
  record.reviewSnapshot = cartSnapshot(cart);
  store.saveConversation(owner, record);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let submit: () => Promise<any> = async () => ({ orderId: 'order-real' });
  const gateway: ToolGateway = {
    listTools: async () => [],
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'getCart') return structuredClone(cart);
      if (name === 'submitOrder') return submit();
      if (name === 'createCart') return { cartId: 'cart-real' };
      if (name === 'listPaymentMethods') return { paymentMethods: [{ paymentMethodId: 'pix-real', kind: 'PIX' }] };
      if (name === 'getCartDeliveryMethods') return { deliveryMethods: [{ deliveryMethodId: 'delivery-real', deliveryMethodName: 'Padrão', fee: 5 }] };
      if (name === 'listVouchers') return { vouchers: [] };
      return {};
    },
  };
  const service = new CheckoutService(store);
  const input = { reviewId: 'review-real', version: 1, userConsent: true };
  return { owner, store, record, gateway, calls, service, input, cart, setSubmit(fn: () => Promise<any>) { submit = fn; } };
}

test('only a reviewed Pix cart reaches submitOrder, with server-owned cartId', async () => {
  const f = fixture();
  const receipt = await f.service.confirm(f.owner, f.gateway, f.record, f.input);
  assert.equal(receipt.id, 'order-real');
  assert.deepEqual(f.calls.find(c => c.name === 'submitOrder')?.args, { cartId: 'cart-real', userConsent: true });
  assert.equal(receipt.status, undefined); // orderId does not imply payment or confirmation
  f.store.close();
});
test('explicit consent is mandatory and no tool is called without it', async () => {
  const f = fixture();
  await assert.rejects(f.service.confirm(f.owner, f.gateway, f.record, { ...f.input, userConsent: false }), /explicitamente/);
  assert.equal(f.calls.length, 0); f.store.close();
});
test('forged or old review identifiers cannot submit an order', async () => {
  const f = fixture();
  await assert.rejects(f.service.confirm(f.owner, f.gateway, f.record, { ...f.input, reviewId: 'other' }));
  await assert.rejects(f.service.confirm(f.owner, f.gateway, f.record, { ...f.input, version: 0 }));
  assert.equal(f.calls.length, 0); f.store.close();
});
test('price changes invalidate consent and return an updated review', async () => {
  const f = fixture(); f.cart.summary.totalAmount = 40;
  await assert.rejects(f.service.confirm(f.owner, f.gateway, f.record, f.input), (error: any) => error.code === 'REVIEW_CHANGED' && error.extra.review.version === 2 && error.extra.review.totals.total === 40);
  assert.equal(f.calls.some(c => c.name === 'submitOrder'), false); f.store.close();
});
for (const kind of ['CREDIT', 'DEBIT', 'CASH', 'MEAL_VOUCHER', '', null, 'pix']) {
  test(`payment ${String(kind)} is rejected before submission`, async () => {
    const f = fixture(); f.cart.paymentMethod.kind = kind;
    await assert.rejects(f.service.confirm(f.owner, f.gateway, f.record, f.input), (error: any) => /Pix/.test(error.message) && error.extra.review.ready === false && error.extra.review.paymentKind === undefined);
    assert.equal(f.calls.some(c => c.name === 'submitOrder'), false); f.store.close();
  });
}
test('a card token is rejected even if the provider labels payment Pix', () => {
  assert.throws(() => assertPix({ paymentMethod: { kind: 'PIX', paymentMethodId: 'pix', cardTokenId: 'saved-card' } }), /cartão/);
});
test('a changed Pix payment ID requires a new review', async () => {
  const f = fixture(); f.cart.paymentMethod.paymentMethodId = 'other-pix';
  await assert.rejects(f.service.confirm(f.owner, f.gateway, f.record, f.input), /mudou/);
  assert.equal(f.calls.some(c => c.name === 'submitOrder'), false); f.store.close();
});
test('minimum, delivery, missing totals and required options block finalization', () => {
  const f = fixture(); f.cart.summary.subtotalAmount = 1; f.cart.summary.totalAmount = undefined;
  f.record.itemCache[item.itemId].optionGroups = [{ id: 'g', name: 'Tamanho', min: 1, max: 1, options: [{ id: 'o', name: 'Grande' }] }];
  const review = normalizeReview(f.cart, { ...f.record.review!, deliveryMethodId: undefined }, f.record);
  assert.equal(review.ready, false);
  assert.ok(review.blockers.some(b => b.includes('mínimo')));
  assert.ok(review.blockers.some(b => b.includes('entrega')));
  assert.ok(review.blockers.some(b => b.includes('total')));
  assert.ok(review.blockers.some(b => b.includes('Tamanho'))); f.store.close();
});
test('repeated confirmation returns the stored receipt, submitting exactly once', async () => {
  const f = fixture();
  const first = await f.service.confirm(f.owner, f.gateway, f.record, f.input);
  const second = await f.service.confirm(f.owner, f.gateway, f.record, f.input);
  assert.deepEqual(first, second); assert.equal(f.calls.filter(c => c.name === 'submitOrder').length, 1); f.store.close();
});
test('simultaneous confirmations cannot create two orders', async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.service.confirm(f.owner, f.gateway, f.record, f.input), f.service.confirm(f.owner, f.gateway, f.record, f.input)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.calls.filter(c => c.name === 'submitOrder').length, 1); f.store.close();
});
test('ambiguous submission is recorded and never retried', async () => {
  const f = fixture(); f.setSubmit(async () => { throw new Error('timeout after write'); });
  await assert.rejects(f.service.confirm(f.owner, f.gateway, f.record, f.input), (e: any) => e.code === 'ORDER_UNKNOWN');
  await assert.rejects(f.service.confirm(f.owner, f.gateway, f.record, f.input), /verificação/);
  assert.equal(f.calls.filter(c => c.name === 'submitOrder').length, 1);
  assert.equal(f.store.orders(f.owner).length, 0); f.store.close();
});
test('missing orderId is not converted into a success receipt', async () => {
  const f = fixture(); f.setSubmit(async () => ({ success: true }));
  await assert.rejects(f.service.confirm(f.owner, f.gateway, f.record, f.input));
  assert.equal(f.store.orders(f.owner).length, 0); f.store.close();
});
test('snapshot ignores hints but covers price, item, address, delivery and payment', () => {
  const f = fixture(); const original = cartSnapshot(f.cart);
  f.cart.agentHints = { retryMessage: 'new text' }; assert.equal(cartSnapshot(f.cart), original);
  for (const field of ['items', 'deliveryAddress', 'deliveryMethod', 'paymentMethod', 'summary']) {
    const altered = structuredClone(f.cart); altered[field] = { modified: true }; assert.notEqual(cartSnapshot(altered), original);
  }
  f.store.close();
});
test('required complements and injected payment fields fail before createCart', async () => {
  const f = fixture(); delete f.record.review;
  f.record.itemCache[item.itemId].optionGroups = [{ id: 'g', name: 'Molho', min: 1, max: 1, options: [{ id: 'o', name: 'Tomate' }] }];
  await assert.rejects(f.service.review(f.owner, f.gateway, f.record, address, { conversationId: f.record.id, itemId: item.itemId, quantity: 1, options: [] }), /Molho/);
  await assert.rejects(f.service.review(f.owner, f.gateway, f.record, address, { conversationId: f.record.id, paymentMethodId: 'credit' } as any), /Pix/);
  assert.equal(f.calls.length, 0); f.store.close();
});
test('persisted attempts survive restart and owner data stays isolated', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'viupediu-store-')); const filename = path.join(dir, 'state.sqlite');
  try {
    let store = new Store(filename); const conv = store.createConversation('a');
    store.beginAttempt('a', 'cart'); store.close(); store = new Store(filename);
    assert.equal(store.attempt('a', 'cart')?.state, 'unknown');
    assert.equal(store.attempt('b', 'cart'), undefined);
    assert.throws(() => store.conversation('b', conv.id));
    assert.equal('history' in publicConversation(store.conversation('a', conv.id)), false); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('prepare, select delivery, review and confirm use only provider Pix and real tool data', async () => {
  const f = fixture(); delete f.record.review; delete f.record.reviewSnapshot;
  const prepared = await f.service.review(f.owner, f.gateway, f.record, address, { conversationId: f.record.id, offerId: 'offer-real', itemId: item.itemId, quantity: 1, options: [], addItem: true });
  assert.equal(prepared.ready, false);
  assert.equal(prepared.paymentKind, 'PIX');
  assert.equal(prepared.totals.total, 35);
  assert.equal(f.calls.some(c => c.name === 'submitOrder'), false);
  const reviewed = await f.service.review(f.owner, f.gateway, f.record, address, { conversationId: f.record.id, deliveryMethodId: 'delivery-real' });
  assert.equal(reviewed.ready, true);
  const receipt = await f.service.confirm(f.owner, f.gateway, f.record, { reviewId: reviewed.id, version: reviewed.version, userConsent: true });
  assert.equal(receipt.id, 'order-real');
  assert.ok(f.calls.filter(c => c.name === 'setCartPayment').every(c => c.args.paymentMethodId === 'pix-real' && !('cardTokenId' in c.args)));
  assert.equal(f.calls.filter(c => c.name === 'createCart').length, 1);
  assert.equal(f.calls.filter(c => c.name === 'submitOrder').length, 1); f.store.close();
});
test('a store without Pix remains blocked and never substitutes a different method', async () => {
  const f = fixture(); delete f.record.review;
  const original = f.gateway.call;
  f.gateway.call = async (name, args) => name === 'listPaymentMethods' ? { paymentMethods: [{ kind: 'CREDIT', paymentMethodId: 'card' }] } : original(name, args);
  const review = await f.service.review(f.owner, f.gateway, f.record, address, { conversationId: f.record.id, offerId: 'offer-real', itemId: item.itemId, quantity: 1, options: [], addItem: true });
  assert.equal(review.ready, false);
  assert.ok(review.blockers.some(b => b.includes('não oferece Pix')));
  assert.equal(f.calls.some(c => c.name === 'setCartPayment'), false);
  await assert.rejects(f.service.confirm(f.owner, f.gateway, f.record, { reviewId: review.id, version: review.version, userConsent: true }));
  assert.equal(f.calls.some(c => c.name === 'submitOrder'), false); f.store.close();
});
