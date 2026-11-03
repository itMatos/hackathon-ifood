import assert from 'node:assert/strict';
import test from 'node:test';
import { CheckoutService, cartSnapshot, normalizeReview } from '../server/checkout.ts';
import type { ToolGateway } from '../server/ifood.ts';
import { publicConversation, Store } from '../server/store.ts';
import type { Address, CartReview } from '../shared/types.ts';

function reviewedCart() {
  const owner = 'review-regression-owner';
  const store = new Store(':memory:');
  const record = store.createConversation(owner);
  const address: Address = { id: 'address-a', label: 'Casa', formatted: 'Rua A, 1', latitude: -22, longitude: -47 };
  record.itemCache.item = { itemId: 'item', merchantId: 'merchant-a', name: 'Produto', optionGroups: [] };
  const cart: any = {
    cartId: 'cart-review', merchant: { merchantId: 'merchant-a', merchantName: 'Loja A' },
    items: [{ itemId: 'item', cartItemId: 'line', name: 'Produto', quantity: 1, options: [], unitPrice: 30 }],
    deliveryAddress: { addressId: address.id, streetName: 'Rua A', streetNumber: '1' },
    deliveryMethod: { deliveryMethodId: 'delivery-a', deliveryMethodName: 'Padrão', deliveryMethodMode: 'STANDARD' },
    paymentMethod: { paymentMethodId: 'pix-a', kind: 'PIX' },
    summary: { subtotalAmount: 30, totalAmount: 35, deliveryFeeAmount: 5 },
  };
  const context: CartReview = {
    id: 'review', version: 1, cartId: cart.cartId, merchantId: 'merchant-a', merchantName: 'Loja A',
    address, items: [], deliveryMethods: [{ id: 'delivery-a', name: 'Padrão', mode: 'STANDARD' }],
    deliveryMethodId: 'delivery-a', paymentMethodId: 'pix-a', vouchers: [], totals: {}, blockers: [], ready: false,
  };
  record.review = normalizeReview(cart, context, record);
  record.reviewSnapshot = cartSnapshot(cart);
  store.saveConversation(owner, record);
  const calls: string[] = [];
  const gateway: ToolGateway = {
    listTools: async () => [],
    call: async name => {
      calls.push(name);
      if (name === 'getCart') return structuredClone(cart);
      if (name === 'submitOrder') return { orderId: 'offline-order' };
      throw new Error(`Unexpected offline tool: ${name}`);
    },
  };
  const service = new CheckoutService(store);
  const confirm = () => service.confirm(owner, gateway, record, {
    reviewId: record.review!.id, version: record.review!.version, userConsent: true,
  });
  return { owner, store, record, cart, calls, confirm };
}

async function assertRepeatedConsentBlocked(fixture: ReturnType<typeof reviewedCart>, expectedBlocker: RegExp) {
  await assert.rejects(fixture.confirm(), (error: any) => error.code === 'REVIEW_CHANGED');
  assert.equal(fixture.record.review!.ready, false);
  assert.match(fixture.record.review!.blockers.join(' '), expectedBlocker);
  await assert.rejects(fixture.confirm(), (error: any) => error.code === 'CART_NOT_READY');
  assert.equal(fixture.calls.filter(name => name === 'submitOrder').length, 0);
  assert.equal(fixture.store.attempt(fixture.owner, fixture.cart.cartId), undefined);
}

test('address drift remains blocked after the user acknowledges the updated version', async () => {
  const f = reviewedCart();
  try {
    f.cart.deliveryAddress.streetName = 'Rua B';
    await assertRepeatedConsentBlocked(f, /endereço.*mudou/i);
    assert.match(f.record.review!.address.formatted, /Rua B/);
    assert.doesNotMatch(f.record.review!.address.formatted, /Rua A/);
    const restored = f.store.conversation(f.owner, f.record.id);
    assert.equal(restored.review!.ready, false);
    assert.notEqual(restored.cartAddressSnapshot, JSON.stringify(f.cart.deliveryAddress));
  } finally { f.store.close(); }
});

test('a different address identifier cannot pass repeated confirmation', async () => {
  const f = reviewedCart();
  try {
    f.cart.deliveryAddress.addressId = 'address-b';
    await assertRepeatedConsentBlocked(f, /endereço/i);
  } finally { f.store.close(); }
});

for (const [field, value] of [
  ['deliveryMethodId', 'delivery-b'],
  ['deliveryMethodName', 'Agendada amanhã'],
  ['deliveryMethodMode', 'SCHEDULED'],
] as const) {
  test(`delivery drift in ${field} cannot be accepted by a second confirmation`, async () => {
    const f = reviewedCart();
    try {
      f.cart.deliveryMethod[field] = value;
      await assertRepeatedConsentBlocked(f, /entrega.*mudou/i);
    } finally { f.store.close(); }
  });
}

test('a changed delivery time slot cannot be accepted while the review still selects the old slot', async () => {
  const f = reviewedCart();
  try {
    f.record.review!.timeSlotId = 'slot-morning';
    f.cart.deliveryMethod.selectedTimeSlotId = 'slot-morning';
    f.record.reviewSnapshot = cartSnapshot(f.cart);
    f.cart.deliveryMethod.selectedTimeSlotId = 'slot-evening';
    await assertRepeatedConsentBlocked(f, /entrega|horário/i);
  } finally { f.store.close(); }
});

for (const field of ['warning', 'warnings', 'validationErrors'] as const) {
  test(`provider blocking impact in ${field} is respected even without a recognized error phrase`, async () => {
    const f = reviewedCart();
    try {
      const warning = { message: 'Confira esta informação.', impact: { canProceedToCheckout: false } };
      f.cart[field] = field === 'warning' ? warning : [warning];
      await assertRepeatedConsentBlocked(f, /Confira esta informação/);
    } finally { f.store.close(); }
  });
}

test('merchant identity drift rejects both confirmation attempts', async () => {
  const f = reviewedCart();
  try {
    f.cart.merchant.merchantId = 'merchant-b';
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(f.confirm(), (error: any) => error.code === 'MERCHANT_CHANGED');
    }
    assert.equal(f.calls.includes('submitOrder'), false);
    assert.equal(f.store.attempt(f.owner, f.cart.cartId), undefined);
  } finally { f.store.close(); }
});

test('a cached item belonging to another merchant cannot reach submission', async () => {
  const f = reviewedCart();
  try {
    f.record.itemCache.item.merchantId = 'merchant-b';
    await assertRepeatedConsentBlocked(f, /outro estabelecimento/i);
  } finally { f.store.close(); }
});

test('private address baselines are preserved internally and omitted from public conversations', () => {
  const f = reviewedCart();
  try {
    assert.equal(typeof f.record.cartAddressSnapshot, 'string');
    const publicRecord = publicConversation(f.record);
    assert.equal('cartAddressSnapshot' in publicRecord, false);
    assert.equal('cartDeliverySnapshot' in publicRecord, false);
    assert.equal('reviewSnapshot' in publicRecord, false);
    assert.equal('itemCache' in publicRecord, false);
  } finally { f.store.close(); }
});

test('a cart already being submitted cannot be submitted under a new local owner', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(store.beginAttempt('owner-before-reconnect', 'same-provider-cart'), true);
    assert.equal(store.beginAttempt('owner-after-reconnect', 'same-provider-cart'), false);
    assert.equal(store.attempt('owner-after-reconnect', 'same-provider-cart'), undefined);
    assert.equal(store.orders('owner-after-reconnect').length, 0);
  } finally { store.close(); }
});
