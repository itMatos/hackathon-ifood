import test from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Offer } from '../shared/types.ts';
import { adoptOfferQuote, curateOffers, quoteOffers } from '../server/curation.ts';
import { CheckoutService } from '../server/checkout.ts';
import type { ToolGateway } from '../server/ifood.ts';
import { Store, publicConversation } from '../server/store.ts';

const address: Address = { id: 'quote-address', label: 'Casa', formatted: 'Rua Teste, 10', latitude: -22, longitude: -47 };
const makeOffer = (merchant = 'a', item = merchant): Offer => ({ id: `${merchant}:${item}`, merchantId: merchant, itemId: item, name: `Produto ${item}`, merchantName: `Loja ${merchant}`, price: 30 });
function fixture(offers = [makeOffer()]) {
  const owner = 'quote-consumer';
  const store = new Store(':memory:');
  const record = store.createConversation(owner); record.offers = offers;
  const checkout = new CheckoutService(store);
  const calls: { name: string; args: Record<string, any> }[] = [];
  const carts = new Map<string, any>();
  const required = new Set<string>(), noPix = new Set<string>();
  let minimum = 20;
  let failVoucher = false;
  const vouchers = (merchant: string) => ['A', 'B', 'C', 'D'].map(code => ({ code: `${merchant}-${code}`, campaignId: `${merchant}-campaign-${code}`, description: `Cupom ${code}`, effectValue: code === 'B' ? 9999 : 1 }));
  const recalculate = (cart: any) => {
    const discount = cart.selectedVoucher?.endsWith('-A') ? 9 : cart.selectedVoucher?.endsWith('-B') ? 2 : cart.selectedVoucher?.endsWith('-C') ? 4 : cart.selectedVoucher?.endsWith('-D') ? 30 : 0;
    cart.summary = { subtotalAmount: 30, deliveryFeeAmount: cart.deliveryMethod?.fee ?? 0, feeTotalAmount: 2, benefitsTotalAmount: 0, voucherTotalAmount: discount, totalAmount: 30 + (cart.deliveryMethod?.fee ?? 0) + 2 - discount };
  };
  const gateway: ToolGateway = {
    listTools: async () => [],
    call: async (name, args) => {
      calls.push({ name, args });
      assert.notEqual(name, 'submitOrder'); assert.equal('cardTokenId' in args, false);
      if (name === 'getMerchant') return { merchantId: args.merchantId, merchantName: `Loja ${args.merchantId}`, featuredItems: [] };
      if (name === 'getItem') return { merchantId: args.merchantId, itemId: args.itemId, itemName: `Produto ${args.itemId}`, unitPrice: 30,
        optionGroups: required.has(String(args.itemId)) ? [{ optionGroupId: 'group', name: 'Tamanho', minSelections: 1, maxSelections: 1, options: [{ optionId: 'choice', name: 'Grande', additionalPrice: 0 }] }] : [],
      };
      if (name === 'listPaymentMethods') return { paymentMethods: noPix.has(String(args.merchantId)) ? [{ kind: 'CREDIT_CARD', paymentMethodId: 'credit' }] : [{ kind: 'PIX', paymentMethodId: `${args.merchantId}-pix`, cardTokenId: null }] };
      if (name === 'createCart') {
        const cart = { cartId: `cart-${carts.size + 1}`, merchant: { merchantId: args.merchantId, merchantName: `Loja ${args.merchantId}`, orderMinimumPrice: minimum },
          items: (args.items as any[]).map((item, index) => ({ ...item, cartItemId: `line-${index}`, name: `Produto ${item.itemId}`, unitPrice: 30 })),
          deliveryAddress: { streetName: 'Rua Teste', streetNumber: '10' }, deliveryMethod: null, paymentMethod: null, summary: {}, fees: [{ name: 'Taxa de serviço', amount: 2 }],
        };
        recalculate(cart); carts.set(cart.cartId, cart); return structuredClone(cart);
      }
      const cart = carts.get(String(args.cartId)); assert.ok(cart, `Cart fixture missing for ${name}`);
      if (name === 'getCartDeliveryMethods') return { deliveryMethods: [
        { deliveryMethodId: 'DEFAULT', deliveryMethodName: 'Entrega padrão', deliveryMethodMode: 'DELIVERY', fee: 5, estimatedMinutes: { min: 20, max: 30 }, timeslots: null },
        { deliveryMethodId: 'CHEAP', deliveryMethodName: 'Entrega econômica', deliveryMethodMode: 'DELIVERY', fee: 2, estimatedMinutes: { min: 40, max: 50 }, timeslots: null },
        { deliveryMethodId: 'TAKEOUT', deliveryMethodName: 'Retirada', deliveryMethodMode: 'TAKEOUT', fee: 0, timeslots: null },
      ] };
      if (name === 'setCartDelivery') cart.deliveryMethod = { deliveryMethodId: args.deliveryMethodId, deliveryMethodName: args.deliveryMethodId === 'DEFAULT' ? 'Entrega padrão' : 'Entrega econômica', deliveryMethodMode: 'DELIVERY', fee: args.deliveryMethodId === 'DEFAULT' ? 5 : 2, estimatedMinutes: { min: 20, max: 30 }, timeSlot: null };
      else if (name === 'setCartPayment') { assert.equal(args.paymentMethodId, `${cart.merchant.merchantId}-pix`); cart.paymentMethod = { paymentMethodId: args.paymentMethodId, kind: 'PIX', cardTokenId: null }; }
      else if (name === 'listVouchers') return { vouchers: vouchers(cart.merchant.merchantId) };
      else if (name === 'setVoucher') {
        assert.ok(vouchers(cart.merchant.merchantId).some(v => v.code === args.code && v.campaignId === args.campaignId));
        cart.selectedVoucher = args.code; recalculate(cart);
        if (failVoucher) throw Object.assign(new Error('Resultado da aplicação desconhecido.'), { code: 'MCP_REQUEST_FAILED' });
      } else if (name === 'removeVoucher') cart.selectedVoucher = undefined;
      else assert.equal(name, 'getCart');
      recalculate(cart); return structuredClone(cart);
    },
  };
  return { owner, store, record, checkout, gateway, carts, calls, required, noPix, setMinimum(value: number) { minimum = value; }, failVoucher() { failVoucher = true; } };
}

test('curation keeps three relevant choices, preferring distinct stores and filling remaining slots', () => {
  const a = makeOffer('a', 'a1'), a2 = makeOffer('a', 'a2'), b = makeOffer('b'), c = makeOffer('c');
  assert.deepEqual(curateOffers([a, a, a2, b, c]).map(o => o.id), [a.id, b.id, c.id]);
  assert.deepEqual(curateOffers([a, a2, b]).map(o => o.id), [a.id, b.id, a2.id]);
  a.quote = { status: 'ready', addressId: address.id, quotedTotal: 40, availableVouchers: [], blockers: [] };
  b.quote = { status: 'ready', addressId: address.id, quotedTotal: 20, availableVouchers: [], blockers: [] };
  c.quote = { status: 'needs_options', addressId: address.id, availableVouchers: [], blockers: [] }; c.price = 1;
  assert.deepEqual(curateOffers([a, c, b], 'PRICE').map(o => o.id), [b.id, a.id, c.id]);
});

test('quotes use actual totals and best of three scoped vouchers, preserving private carts and active review', async () => {
  const f = fixture([makeOffer('a'), makeOffer('b'), makeOffer('c'), makeOffer('d')]);
  const updates: Offer[][] = [];
  try {
    const offers = await quoteOffers({ ...f, address, onOffers: values => { updates.push(structuredClone(values)); } });
    assert.equal(offers.length, 3); assert.equal(f.carts.size, 3); assert.equal(f.record.review, undefined);
    for (const offer of offers) {
      assert.equal(offer.quote?.status, 'ready'); assert.equal(offer.quote?.quotedTotal, 28);
      assert.equal(offer.quote?.totals?.serviceFee, 2); assert.equal(offer.quote?.totals?.deliveryFee, 5);
      assert.equal(offer.quote?.totals?.voucherDiscount, 9); assert.equal(offer.quote?.appliedVoucher?.code, `${offer.merchantId}-A`);
      assert.equal(offer.quote?.availableVouchers.length, 4); assert.equal(offer.quote?.delivery?.id, 'DEFAULT'); assert.equal(offer.quote?.delivery?.description, '20–30 min');
      assert.equal(f.calls.some(c => c.name === 'setVoucher' && c.args.code === `${offer.merchantId}-D`), false);
      const stored = f.record.offerQuotes?.[offer.id]; assert.ok(stored?.record.reviewSnapshot);
      assert.equal(f.carts.get(stored!.record.review!.cartId).selectedVoucher, `${offer.merchantId}-A`);
    }
    assert.equal(f.store.conversation(f.owner).id, f.record.id); // Quote records never become the latest chat.
    assert.equal('offerQuotes' in publicConversation(f.store.conversation(f.owner)), false);
    assert.equal(f.store.orders(f.owner).length, 0); assert.ok(updates.some(values => values.some(o => o.quote?.status === 'quoting')));
    const count = f.calls.length; await quoteOffers({ ...f, address }); assert.equal(f.calls.length, count);
  } finally { f.store.close(); }
});

test('required options and merchant-only results cannot create invalid quote carts', async () => {
  const product = makeOffer(), merchant = { ...makeOffer('b'), itemId: undefined };
  const f = fixture([product, merchant]); f.required.add(product.itemId!);
  try {
    await quoteOffers({ ...f, address });
    assert.ok(f.record.offers.every(offer => offer.quote?.status === 'needs_options'));
    assert.equal(f.calls.some(call => call.name === 'createCart' || call.name === 'listVouchers'), false);
    assert.equal(f.record.offers[0].quote?.quotedTotal, undefined);
  } finally { f.store.close(); }
});

test('Pix unavailable prevents quote cart creation, with no fallback payment method', async () => {
  const f = fixture(); f.noPix.add('a');
  try {
    await quoteOffers({ ...f, address });
    assert.equal(f.record.offers[0].quote?.status, 'unavailable'); assert.match(f.record.offers[0].quote!.blockers[0], /Pix/);
    assert.equal(f.calls.some(call => call.name === 'createCart' || call.name === 'setCartPayment'), false);
  } finally { f.store.close(); }
});

test('minimum-order blocker still exposes an actual quoted total', async () => {
  const f = fixture(); f.setMinimum(100);
  try {
    await quoteOffers({ ...f, address });
    const quote = f.record.offers[0].quote!;
    assert.equal(quote.status, 'ready'); assert.equal(quote.quotedTotal, 28); assert.ok(quote.blockers.some(text => /mínimo/.test(text)));
    assert.equal(f.record.offerQuotes?.[f.record.offers[0].id].record.review?.ready, false);
  } finally { f.store.close(); }
});

test('adoption isolates owner/address and preserves subsequent active-cart edits', async () => {
  const f = fixture();
  try {
    await quoteOffers({ ...f, address }); const offerId = f.record.offers[0].id;
    assert.equal(adoptOfferQuote({ ...f, offerId, address, owner: 'other-consumer' }), false);
    assert.equal(adoptOfferQuote({ ...f, offerId, address: { ...address, latitude: -23 } }), false);
    assert.equal(adoptOfferQuote({ ...f, offerId, address }), true); assert.equal(f.record.review?.totals.total, 28);
    f.record.review!.items[0].quantity = 2; f.record.reviewSnapshot = 'active-snapshot';
    assert.equal(adoptOfferQuote({ ...f, offerId, address }), true); assert.equal(f.record.review?.items[0].quantity, 2); assert.equal(f.record.reviewSnapshot, 'active-snapshot');
    f.store.beginAttempt(f.owner, f.record.review!.cartId);
    assert.equal(adoptOfferQuote({ ...f, offerId, address }), false);
  } finally { f.store.close(); }
});

test('expired quotes refresh the same inactive cart and changed address invalidates context', async () => {
  const f = fixture();
  try {
    await quoteOffers({ ...f, address });
    const entry = f.record.offerQuotes![f.record.offers[0].id]; const cartId = entry.record.review!.cartId;
    entry.quote.quotedAt = new Date(Date.now() - 121_000).toISOString();
    await quoteOffers({ ...f, address });
    assert.equal(f.carts.size, 1); assert.equal(f.record.offerQuotes![f.record.offers[0].id].record.review?.cartId, cartId);
    await quoteOffers({ ...f, address: { ...address, latitude: -23 } });
    assert.equal(f.carts.size, 2); assert.notEqual(f.record.offerQuotes![f.record.offers[0].id].record.review?.cartId, cartId);
  } finally { f.store.close(); }
});

test('ambiguous coupon mutation stops comparison and is never retried automatically', async () => {
  const f = fixture(); f.failVoucher();
  try {
    await quoteOffers({ ...f, address });
    assert.equal(f.record.offers[0].quote?.status, 'unavailable'); assert.equal(f.record.offers[0].quote?.quotedTotal, undefined);
    assert.equal(f.calls.filter(c => c.name === 'setVoucher').length, 1);
    const calls = f.calls.length; await quoteOffers({ ...f, address }); assert.equal(f.calls.length, calls);
    assert.equal(f.calls.some(c => c.name === 'submitOrder'), false);
  } finally { f.store.close(); }
});
