import { createHash } from 'node:crypto';
import type { Address, CartReview, Offer, OfferQuote, Voucher } from '../shared/types.ts';
import { assertPix, cartSnapshot, CheckoutService, normalizeReview } from './checkout.ts';
import { AppError } from './errors.ts';
import type { ToolGateway } from './ifood.ts';
import { SerialLocks, type ConversationRecord, type Store } from './store.ts';

export interface StoredOfferQuote {
  contextKey: string;
  quote: OfferQuote;
  record: ConversationRecord;
}
type QuoteRecord = ConversationRecord & { offerQuotes?: Record<string, StoredOfferQuote> };
type Sort = 'RELEVANCE' | 'PRICE' | 'DELIVERY_TIME';
const locks = new SerialLocks();
const MAX_OFFERS = 3;
const MAX_VOUCHERS = 3;
const MAX_CALLS = 90;
const QUOTE_WINDOW_MS = 90_000;
const CACHE_MS = 120_000;
const object = (value: any): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const numeric = (value: any): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function body(raw: any): Record<string, any> {
  let value = object(raw);
  for (let depth = 0; depth < 8; depth++) {
    const nested = value.response ?? value.data;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) break;
    value = nested;
  }
  return value;
}

/** Preserve provider relevance, prefer different stores, and expose at most three choices. */
export function curateOffers(offers: Offer[], sort: Sort = 'RELEVANCE'): Offer[] {
  const distinct = [...new Map(offers.filter(offer => offer?.id && offer.merchantId).map(offer => [offer.id, offer])).values()];
  const hasQuotes = distinct.some(offer => offer.quote !== undefined);
  const ranked = distinct.map((offer, index) => ({ offer, index })).sort((a, b) => {
    const score = (offer: Offer): number => {
      if (sort === 'PRICE') return hasQuotes
        ? offer.quote?.status === 'ready' && numeric(offer.quote.quotedTotal) ? offer.quote.quotedTotal : Infinity
        : offer.price ?? Infinity;
      if (sort === 'DELIVERY_TIME') return offer.deliveryMinutes ?? Infinity;
      return 0;
    };
    const comparison = score(a.offer) - score(b.offer);
    return Number.isNaN(comparison) || comparison === 0 ? a.index - b.index : comparison;
  }).map(entry => entry.offer);
  const selected: Offer[] = [];
  const merchants = new Set<string>();
  for (const offer of ranked) if (!merchants.has(offer.merchantId)) {
    selected.push(offer); merchants.add(offer.merchantId);
    if (selected.length === MAX_OFFERS) return selected;
  }
  for (const offer of ranked) if (!selected.some(value => value.id === offer.id)) {
    selected.push(offer); if (selected.length === MAX_OFFERS) break;
  }
  return selected;
}

function contextKey(owner: string, address: Address, offer: Offer): string {
  return createHash('sha256').update(JSON.stringify({
    owner, address, offerId: offer.id, merchantId: offer.merchantId, itemId: offer.itemId,
    price: offer.price, deliveryFee: offer.deliveryFee, minimumOrder: offer.minimumOrder, quantity: 1, options: [],
  })).digest('hex');
}

interface QuoteInput {
  owner: string;
  store: Store;
  checkout: CheckoutService;
  gateway: ToolGateway;
  record: QuoteRecord;
  address: Address;
  onProgress?: (text: string) => void | Promise<void>;
  onOffers?: (offers: Offer[]) => void | Promise<void>;
}

/** Quotes prepare carts, delivery and Pix, but can never submit an order. */
export async function quoteOffers(input: QuoteInput): Promise<Offer[]> {
  return locks.run(`${input.owner}:${input.record.id}`, async () => {
    const { owner, store, checkout, record, address } = input;
    const deadline = Date.now() + QUOTE_WINDOW_MS;
    let calls = 0;
    const gateway: ToolGateway = {
      listTools: () => input.gateway.listTools(),
      call: async (name, args) => {
        if (name === 'submitOrder' || /card/i.test(name) || args.cardTokenId) throw new AppError('Cotações não podem enviar pedidos nem usar cartões.', 403, 'QUOTE_TOOL_FORBIDDEN');
        if (Date.now() >= deadline || ++calls > MAX_CALLS) throw new AppError('A cotação atingiu o limite de consultas. Confira os detalhes ao escolher a oferta.', 408, 'QUOTE_LIMIT');
        // Await every mutation. No Promise.race may leave a cart write running after unlock.
        return await input.gateway.call(name, args);
      },
    };
    record.offerQuotes ??= {};
    record.offers = curateOffers(record.offers);
    const publish = async () => { store.saveConversation(owner, record); await input.onOffers?.(record.offers); };
    for (const offer of record.offers) {
      const key = contextKey(owner, address, offer);
      const existing = record.offerQuotes[offer.id];
      const sameContext = existing?.contextKey === key;
      const isActive = sameContext && existing.record.review?.cartId === record.review?.cartId;
      const expired = sameContext && existing.quote.quotedAt && Date.now() - Date.parse(existing.quote.quotedAt) > CACHE_MS;
      const refresh = Boolean(sameContext && expired && !isActive && existing.record.review && existing.quote.status === 'ready');
      if (sameContext && !refresh) {
        if (existing.quote.status === 'quoting') {
          existing.quote.status = 'unavailable'; existing.quote.blockers = ['Esta cotação foi interrompida. Confira a oferta antes de continuar.'];
        }
        offer.quote = existing.quote;
        await publish();
        continue;
      }
      const quote: OfferQuote = { status: 'quoting', addressId: address.id, availableVouchers: [], blockers: [] };
      const { quote: _previousQuote, ...catalogOffer } = offer;
      const virtual: ConversationRecord = refresh ? existing.record : { id: `${record.id}:quote:${key.slice(0, 16)}`, messages: [], offers: [catalogOffer], history: [], itemCache: {} };
      virtual.offers = [catalogOffer];
      const entry: StoredOfferQuote = { contextKey: key, quote, record: virtual };
      record.offerQuotes[offer.id] = entry; offer.quote = quote;
      await publish();
      if (!offer.itemId) {
        quote.status = 'needs_options'; quote.blockers = ['Escolha um item da loja para consultar o total com taxas e cupons.'];
        await publish(); continue;
      }
      if (Date.now() >= deadline) {
        quote.status = 'unavailable'; quote.blockers = ['A consulta de preços terminou. Confira esta oferta ao selecioná-la.'];
        await publish(); continue;
      }
      await input.onProgress?.(`Conferindo taxas e cupons em ${offer.merchantName}…`);
      try {
        const items = await checkout.loadItems(gateway, virtual, offer.id, address);
        const item = items.find(value => value.itemId === offer.itemId && value.merchantId === offer.merchantId);
        if (!item) throw new AppError('Este item não está disponível no catálogo atual.', 422, 'ITEM_UNAVAILABLE');
        Object.assign(record.itemCache, virtual.itemCache);
        if (item.optionGroups.some(group => group.min > 0)) {
          quote.status = 'needs_options'; quote.blockers = ['Escolha os complementos obrigatórios para consultar o preço final.'];
          await publish(); continue;
        }
        const methods = body(await gateway.call('listPaymentMethods', { merchantId: offer.merchantId })).paymentMethods;
        if (!Array.isArray(methods) || !methods.some(method => method.kind === 'PIX' && typeof method.paymentMethodId === 'string' && !method.cardTokenId)) {
          throw new AppError('Esta loja não oferece Pix para esta cotação.', 422, 'PIX_REQUIRED');
        }
        // Store all quote state inside its parent conversation; never create another visible chat.
        const scopedStore = new Proxy(store, {
          get(target, property) {
            if (property === 'saveConversation') return (scopeOwner: string, updated: ConversationRecord) => {
              if (scopeOwner !== owner || updated.id !== virtual.id) throw new AppError('Contexto de cotação inválido.', 403, 'QUOTE_CONTEXT');
              entry.record = updated;
              target.saveConversation(owner, record);
            };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const scopedCheckout = new CheckoutService(scopedStore);
        let review = await scopedCheckout.review(owner, gateway, virtual, address, refresh
          ? { conversationId: virtual.id }
          : { conversationId: virtual.id, offerId: offer.id, itemId: item.itemId, quantity: 1, options: [] });
        if (review.items.length !== 1 || review.items[0].itemId !== offer.itemId || review.items[0].quantity !== 1 || review.items[0].options.length !== 0) {
          throw new AppError('O carrinho desta oferta foi alterado. Confira os itens ao selecioná-la.', 409, 'QUOTE_CART_CHANGED');
        }
        quote.availableVouchers = review.vouchers;
        const eligible = review.deliveryMethods.filter(method => method.mode === 'DELIVERY' && !method.timeSlots?.length && !/SCHEDULED/i.test(method.id));
        const delivery = eligible.find(method => method.id === 'DEFAULT') || [...eligible].sort((a, b) => (a.fee ?? Infinity) - (b.fee ?? Infinity))[0];
        if (!delivery) throw new AppError('Não há entrega imediata disponível para esta oferta.', 422, 'DELIVERY_UNAVAILABLE');
        review = await scopedCheckout.review(owner, gateway, virtual, address, { conversationId: virtual.id, deliveryMethodId: delivery.id, voucher: null });
        quote.availableVouchers = review.vouchers;
        const candidates = [...new Map(review.vouchers.map(voucher => [`${voucher.code}:${voucher.campaignId}`, voucher])).values()].slice(0, MAX_VOUCHERS);
        let bestVoucher: Voucher | undefined;
        let bestTotal = review.totals.total;
        if (!numeric(bestTotal)) throw new AppError('O iFood não informou o total desta oferta.', 502, 'QUOTE_TOTAL_UNAVAILABLE');
        const readCurrent = async (): Promise<CartReview> => {
          const raw = await gateway.call('getCart', { cartId: virtual.review!.cartId });
          assertPix(raw, virtual.review!.paymentMethodId);
          const refreshed = normalizeReview(raw, { ...virtual.review!, version: virtual.review!.version + 1 }, virtual);
          virtual.review = refreshed; virtual.reviewSnapshot = cartSnapshot(raw);
          scopedStore.saveConversation(owner, virtual);
          return refreshed;
        };
        let currentVoucher: Voucher | undefined;
        for (const voucher of candidates) {
          try {
            await gateway.call('setVoucher', { cartId: review.cartId, code: voucher.code, campaignId: voucher.campaignId });
            currentVoucher = voucher;
            virtual.review!.selectedVoucher = voucher.code;
            review = await readCurrent();
            if (numeric(review.totals.total) && review.totals.total < bestTotal) { bestTotal = review.totals.total; bestVoucher = voucher; }
          } catch (error) {
            // Only a definite domain rejection can safely continue comparison.
            if ((error as any)?.code !== 'VOUCHER_INVALID') throw error;
          }
        }
        const currentKey = currentVoucher && `${currentVoucher.code}:${currentVoucher.campaignId}`;
        const bestKey = bestVoucher && `${bestVoucher.code}:${bestVoucher.campaignId}`;
        if (currentKey !== bestKey) {
          if (bestVoucher) await gateway.call('setVoucher', { cartId: review.cartId, code: bestVoucher.code, campaignId: bestVoucher.campaignId });
          else await gateway.call('removeVoucher', { cartId: review.cartId });
          virtual.review!.selectedVoucher = bestVoucher?.code;
          review = await readCurrent();
        }
        review = await readCurrent();
        if (review.paymentKind !== 'PIX' || !review.paymentMethodId || !numeric(review.totals.total)) throw new AppError('Não foi possível validar o total com Pix.', 422, 'QUOTE_NOT_READY');
        quote.status = 'ready'; quote.quotedAt = new Date().toISOString(); quote.quotedTotal = review.totals.total;
        quote.totals = review.totals; quote.delivery = delivery; quote.appliedVoucher = bestVoucher; quote.blockers = review.blockers;
      } catch (error) {
        quote.status = 'unavailable'; quote.blockers = [error instanceof Error ? error.message : 'Não foi possível conferir os custos desta oferta.'];
        if ((error as any)?.status === 401 || (error as any)?.code === 'AUTH_REQUIRED') { await publish(); throw error; }
      }
      await publish();
    }
    return record.offers;
  });
}

/** Reuse the quoted cart without overwriting later edits to an already active cart. */
export function adoptOfferQuote({ record, offerId, address, owner, store }: { record: QuoteRecord; offerId: string; address: Address; owner: string; store: Store }): boolean {
  const offer = record.offers.find(value => value.id === offerId);
  const entry = record.offerQuotes?.[offerId];
  if (!offer || !entry || entry.contextKey !== contextKey(owner, address, offer) || !entry.record.review) return false;
  const quoted = entry.record.review;
  if (store.attempt(owner, quoted.cartId) || (record.review && store.attempt(owner, record.review.cartId))) return false;
  if (record.review?.cartId === quoted.cartId) return true;
  if (quoted.items.length !== 1 || quoted.items[0].itemId !== offer.itemId || quoted.items[0].quantity !== 1 || quoted.items[0].options.length !== 0) return false;
  record.review = structuredClone(quoted);
  record.reviewSnapshot = entry.record.reviewSnapshot;
  record.cartAddressSnapshot = entry.record.cartAddressSnapshot;
  record.cartDeliverySnapshot = entry.record.cartDeliverySnapshot;
  Object.assign(record.itemCache, structuredClone(entry.record.itemCache));
  store.saveConversation(owner, record);
  return true;
}
