import { createHash, randomUUID } from 'node:crypto';
import type { Address, CartReview, CartTotals, DeliveryMethod, ItemDetails, OrderReceipt, ReviewRequest, SelectedOption, Voucher } from '../shared/types.ts';
import type { ToolGateway } from './ifood.ts';
import { normalizeItems } from './ifood.ts';
import { AppError, assert } from './errors.ts';
import { SerialLocks, Store, type ConversationRecord } from './store.ts';

const obj = (v: any): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const array = (v: any): any[] => Array.isArray(v) ? v : [];
const amount = (v: any): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const body = (v: any): any => v?.response ?? v?.data ?? v;
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
export function cartSnapshot(raw: any): string {
  const c = body(raw);
  const important = { cartId: c.cartId, merchant: c.merchant, items: c.items, deliveryAddress: c.deliveryAddress, deliveryMethod: c.deliveryMethod, paymentMethod: c.paymentMethod, summary: c.summary, fees: c.fees, warning: c.warning, warnings: c.warnings, validationErrors: c.validationErrors, canCheckout: c.canCheckout };
  return createHash('sha256').update(JSON.stringify(canonical(important))).digest('hex');
}
export function assertPix(cart: any, expectedId?: string) {
  const payment = obj(body(cart)?.paymentMethod);
  assert(payment.kind === 'PIX', 'O carrinho deve estar configurado exclusivamente para Pix.', 409, 'PIX_REQUIRED');
  assert(!payment.cardTokenId, 'Dados de cartão não são permitidos neste checkout.', 409, 'PIX_REQUIRED');
  assert(typeof payment.paymentMethodId === 'string' && (!expectedId || payment.paymentMethodId === expectedId), 'A forma de pagamento mudou. Revise o carrinho.', 409, 'PIX_REQUIRED');
}
function validateOptions(item: ItemDetails, selected: SelectedOption[]) {
  assert(Array.isArray(selected) && selected.length <= 100, 'Complementos inválidos.');
  const seen = new Set<string>();
  for (const choice of selected) {
    const group = item.optionGroups.find(g => g.id === choice.groupId);
    assert(group?.options.some(o => o.id === choice.optionId), 'Selecione somente complementos disponíveis para este item.');
    assert(Number.isInteger(choice.quantity) && choice.quantity >= 1 && choice.quantity <= 99, 'Quantidade de complemento inválida.');
    assert(!seen.has(choice.optionId), 'Complemento repetido.'); seen.add(choice.optionId);
  }
  for (const group of item.optionGroups) {
    const count = selected.filter(s => s.groupId === group.id).reduce((s, o) => s + o.quantity, 0);
    assert(count >= group.min && count <= group.max, `Escolha entre ${group.min} e ${group.max} opções em “${group.name}”.`);
  }
}
function apiOptions(selected: SelectedOption[]) {
  return selected.map(o => ({ optionId: o.optionId, quantity: o.quantity, customizations: [] }));
}
function retainedOptions(raw: any[]) {
  return raw.map(o => ({ optionId: o.optionId, quantity: o.quantity ?? 1, ...(typeof o.customerNote === 'string' ? { customerNote: o.customerNote } : {}), customizations: array(o.customizations).map(c => ({ customizationId: c.customizationId, quantity: c.quantity ?? 1, ...(typeof c.customerNote === 'string' ? { customerNote: c.customerNote } : {}) })) }));
}
function deliveries(raw: any): DeliveryMethod[] {
  return array(body(raw)?.deliveryMethods).flatMap(d => typeof d.deliveryMethodId === 'string' ? [{
    id: d.deliveryMethodId, name: d.deliveryMethodName || d.deliveryMethodMode || 'Entrega', mode: d.deliveryMethodMode, fee: amount(d.fee),
    description: d.estimatedMinutes ? `${d.estimatedMinutes.min}–${d.estimatedMinutes.max} min` : undefined,
    timeSlots: array(d.timeslots ?? d.timeSlots).filter(t => typeof (t.selectedTimeSlotId ?? t.timeSlotId ?? t.id) === 'string').map(t => ({ id: t.selectedTimeSlotId ?? t.timeSlotId ?? t.id, label: t.label ?? `${t.from} – ${t.to}` })),
  }] : []);
}
function vouchers(raw: any): Voucher[] {
  const data = body(raw);
  return array(data?.vouchers ?? data?.availableVouchers ?? data).filter(v => typeof v.code === 'string' && typeof v.campaignId === 'string').map(v => ({ code: v.code, campaignId: v.campaignId, title: v.description || v.name || v.code }));
}
export function normalizeReview(raw: any, context: CartReview, record: ConversationRecord): CartReview {
  const c = body(raw);
  assert(c && typeof c.cartId === 'string' && c.cartId === context.cartId, 'O iFood retornou um carrinho inválido.', 502, 'INVALID_CART');
  assert(c.merchant?.merchantId === context.merchantId, 'O estabelecimento do carrinho mudou. Prepare outro carrinho.', 409, 'MERCHANT_CHANGED');
  const summary = obj(c.summary);
  const totals: CartTotals = {
    subtotal: amount(summary.subtotalAmount), total: amount(summary.totalAmount), deliveryFee: amount(summary.deliveryFeeAmount),
    serviceFee: amount(summary.feeTotalAmount),
    discount: amount(summary.discountTotalAmount ?? summary.discountAmount),
    benefitsDiscount: amount(summary.benefitsTotalAmount),
    voucherDiscount: amount(summary.voucherTotalAmount),
    minimumOrder: amount(c.merchant?.orderMinimumPrice),
  };
  const items = array(c.items).map(i => ({
    itemId: i.itemId, cartItemId: i.cartItemId, name: i.name ?? i.itemName ?? 'Item', quantity: i.quantity,
    price: amount(i.unitPrice), total: amount(i.totalPrice ?? i.totalAmount),
    options: array(i.options).map(o => ({ groupId: record.itemCache[i.itemId]?.optionGroups.find(g => g.options.some(x => x.id === o.optionId))?.id ?? '', optionId: o.optionId, quantity: o.quantity ?? 1 })),
    optionLabels: array(i.options).map(o => {
      const name = o.name ?? record.itemCache[i.itemId]?.optionGroups.flatMap(g => g.options).find(x => x.id === o.optionId)?.name;
      const nested = array(o.customizations).filter(c => typeof c.name === 'string').map(c => `${c.quantity ?? 1}× ${c.name}`).join(', ');
      return name ? `${o.quantity ?? 1}× ${name}${nested ? ` (${nested})` : ''}` : undefined;
    }).filter((v): v is string => typeof v === 'string'),
  }));
  const blockers: string[] = [];
  const currentAddress = obj(c.deliveryAddress);
  const addressSnapshot = JSON.stringify(canonical(currentAddress));
  if (!record.cartAddressSnapshot && Object.keys(currentAddress).length) record.cartAddressSnapshot = addressSnapshot;
  if (!Object.keys(currentAddress).length) blockers.push('O iFood não informou o endereço do carrinho.');
  if (record.cartAddressSnapshot && record.cartAddressSnapshot !== addressSnapshot) blockers.push('O endereço do carrinho mudou no iFood. Inicie uma nova conversa para preparar outro carrinho.');
  if (currentAddress.addressId && currentAddress.addressId !== context.address.id) blockers.push('O endereço do carrinho difere do endereço selecionado.');
  const actualFormatted = typeof currentAddress.formattedAddress === 'string' ? currentAddress.formattedAddress : [currentAddress.streetName, currentAddress.streetNumber, currentAddress.complement, currentAddress.neighborhood, currentAddress.city, currentAddress.state].filter(v => typeof v === 'string' && v).join(', ');
  const actualAddress = { ...context.address, formatted: actualFormatted || 'Endereço não informado pelo iFood' };
  if (!items.length) blockers.push('Adicione pelo menos um item.');
  if (!context.deliveryMethodId || !c.deliveryMethod) blockers.push('Escolha uma opção de entrega.');
  const selectedDelivery = context.deliveryMethods.find(d => d.id === context.deliveryMethodId);
  if (c.deliveryMethod?.deliveryMethodId && c.deliveryMethod.deliveryMethodId !== context.deliveryMethodId) blockers.push('A opção de entrega do carrinho mudou. Escolha novamente a entrega.');
  const deliverySnapshot = JSON.stringify(canonical({ mode: c.deliveryMethod?.deliveryMethodMode, name: c.deliveryMethod?.deliveryMethodName, timeSlot: c.deliveryMethod?.timeSlot, selectedTimeSlotId: c.deliveryMethod?.selectedTimeSlotId, timeSlotId: c.deliveryMethod?.timeSlotId, id: c.deliveryMethod?.deliveryMethodId }));
  const actualSlotId = c.deliveryMethod?.selectedTimeSlotId ?? c.deliveryMethod?.timeSlotId ?? c.deliveryMethod?.timeSlot?.id;
  if (actualSlotId && actualSlotId !== context.timeSlotId) blockers.push('O horário de entrega do carrinho mudou. Escolha novamente a entrega.');
  if (!record.cartDeliverySnapshot && context.deliveryMethodId && c.deliveryMethod) record.cartDeliverySnapshot = deliverySnapshot;
  if (record.cartDeliverySnapshot && record.cartDeliverySnapshot !== deliverySnapshot) blockers.push('A modalidade ou o horário de entrega mudou no iFood. Escolha novamente a entrega.');
  if (selectedDelivery && c.deliveryMethod && ((selectedDelivery.mode && selectedDelivery.mode !== c.deliveryMethod.deliveryMethodMode) || (c.deliveryMethod.deliveryMethodName && selectedDelivery.name !== c.deliveryMethod.deliveryMethodName))) blockers.push('A entrega do carrinho mudou no iFood. Escolha novamente uma opção de entrega.');
  if (c.paymentMethod?.kind !== 'PIX' || c.paymentMethod?.cardTokenId || c.paymentMethod?.paymentMethodId !== context.paymentMethodId) blockers.push('Pix precisa estar disponível e confirmado no carrinho.');
  if (totals.total === undefined) blockers.push('O iFood ainda não informou o total final.');
  if (totals.minimumOrder !== undefined && totals.subtotal !== undefined && totals.subtotal < totals.minimumOrder) blockers.push(`O subtotal está abaixo do pedido mínimo de R$ ${totals.minimumOrder.toFixed(2).replace('.', ',')}.`);
  if (c.canCheckout === false) blockers.push('O iFood informou que este carrinho ainda não pode ser enviado.');
  for (const warning of [...array(c.validationErrors), ...array(c.warnings), ...(c.warning ? [c.warning] : [])]) {
    const text = typeof warning === 'string' ? warning : warning?.message ?? warning?.description;
    if (warning?.impact?.canProceedToCheckout === false || (text && /mínim|minim|indispon|obrigat|inválid|invalid|unavail|closed|fechad|bloque|insufic/i.test(text))) blockers.push(text || 'O iFood informou uma pendência que impede o envio.');
  }
  for (const line of items) {
    const item = record.itemCache[line.itemId];
    if (!Number.isInteger(line.quantity) || line.quantity < 1) blockers.push('Há uma quantidade inválida no carrinho.');
    if (item) { if (item.merchantId !== context.merchantId) blockers.push('Há um item de outro estabelecimento no carrinho.'); try { validateOptions(item, line.options); } catch (e) { blockers.push((e as Error).message); } }
    else blockers.push('Os detalhes de um item precisam ser consultados novamente.');
  }
  return { ...context, address: actualAddress, merchantName: c.merchant?.merchantName ?? context.merchantName, items, totals, paymentKind: c.paymentMethod?.kind === 'PIX' ? 'PIX' : undefined, blockers: [...new Set(blockers)], ready: blockers.length === 0 };
}

export class CheckoutService {
  private locks = new SerialLocks();
  constructor(private store: Store) {}

  async loadItems(gateway: ToolGateway, record: ConversationRecord, offerId: string, address: Address): Promise<ItemDetails[]> {
    const offer = record.offers.find(o => o.id === offerId);
    assert(offer, 'Esta oferta não está mais disponível. Faça uma nova busca.', 404);
    const location = { latitude: address.latitude, longitude: address.longitude };
    const merchant = body(await gateway.call('getMerchant', { merchantId: offer.merchantId, userLocation: location }));
    const candidates = offer.itemId ? [{ itemId: offer.itemId }] : normalizeItems(merchant, offer.merchantId);
    const results: ItemDetails[] = [];
    const bounded = candidates.slice(0, 12);
    for (let offset = 0; offset < bounded.length; offset += 3) {
      const batch = await Promise.all(bounded.slice(offset, offset + 3).map(async candidate => {
        const raw = await gateway.call('getItem', { merchantId: offer.merchantId, itemId: candidate.itemId, userLocation: location });
        return normalizeItems(body(raw), offer.merchantId).find(i => i.itemId === candidate.itemId);
      }));
      for (const item of batch) if (item) { record.itemCache[item.itemId] = item; results.push(item); }
    }
    return results;
  }

  async review(owner: string, gateway: ToolGateway, record: ConversationRecord, address: Address, request: ReviewRequest): Promise<CartReview> {
    return this.locks.run(`${owner}:${record.id}`, async () => {
      const forbidden = Object.keys(request).some(k => /payment|card|consent|submit/i.test(k));
      assert(!forbidden, 'Este checkout aceita exclusivamente Pix.');
      let review = record.review;
      if (review) assert(!this.store.attempt(owner, review.cartId), 'Este carrinho já foi enviado ou está em verificação. Inicie outra conversa para um novo carrinho.', 409, 'ORDER_PENDING');
      if (review && review.address.id !== address.id) throw new AppError('O endereço mudou. Inicie uma nova conversa para preparar outro carrinho.', 409, 'ADDRESS_CHANGED');
      if (request.offerId || request.itemId) {
        const offer = request.offerId ? record.offers.find(o => o.id === request.offerId) : undefined;
        if (request.offerId) assert(offer, 'Oferta não encontrada.', 404);
        const itemId = request.itemId ?? offer?.itemId;
        assert(itemId, 'Escolha um item do estabelecimento.');
        if (offer && !record.itemCache[itemId]) await this.loadItems(gateway, record, offer.id, address);
        const item = record.itemCache[itemId];
        assert(item && (!offer || item.merchantId === offer.merchantId), 'Consulte os detalhes do item antes de adicioná-lo.');
        assert(!review || review.merchantId === item.merchantId, 'Cada carrinho pertence a uma loja. Inicie outra conversa para trocar de loja.');
        const quantity = request.quantity ?? 1;
        assert(Number.isInteger(quantity) && quantity >= 0 && quantity <= 99, 'Escolha uma quantidade entre 1 e 99.');
        const options = request.options ?? [];
        if (quantity > 0) validateOptions(item, options);
        if (!review) {
          assert(quantity > 0, 'Adicione pelo menos um item.');
          const created = body(await gateway.call('createCart', { merchantId: item.merchantId, addressId: address.id, items: [{ itemId, quantity, options: apiOptions(options) }] }));
          assert(typeof created?.cartId === 'string', 'O iFood não confirmou a criação do carrinho.', 502, 'INVALID_CART');
          review = { id: randomUUID(), version: 0, cartId: created.cartId, merchantId: item.merchantId, merchantName: offer?.merchantName ?? created.merchant?.merchantName ?? '', address, items: [], deliveryMethods: [], vouchers: [], totals: {}, blockers: [], ready: false };
          record.review = review;
          this.store.saveConversation(owner, record); // retain the returned cart ID even if a later step fails
        } else if (request.addItem) {
          assert(quantity > 0, 'Escolha uma quantidade positiva.');
          await gateway.call('addItemToCart', { cartId: review.cartId, itemId, quantity, options: apiOptions(options) });
        } else {
          const current = body(await gateway.call('getCart', { cartId: review.cartId }));
          const matches = array(current.items).filter(i => i.itemId === itemId && (!request.cartItemId || i.cartItemId === request.cartItemId));
          assert(matches.length === 1 && typeof matches[0].cartItemId === 'string', 'Selecione a linha correta do carrinho para alterar.');
          if (quantity === 0) await gateway.call('removeItemFromCart', { cartId: review.cartId, cartItemId: matches[0].cartItemId });
          else {
            const fromCart = array(matches[0].options);
            const unchanged = JSON.stringify(canonical(options.map(o => ({ optionId: o.optionId, quantity: o.quantity })).sort((a,b) => a.optionId.localeCompare(b.optionId)))) === JSON.stringify(canonical(fromCart.map(o => ({ optionId: o.optionId, quantity: o.quantity ?? 1 })).sort((a,b) => a.optionId.localeCompare(b.optionId))));
            await gateway.call('updateCartItem', { cartId: review.cartId, cartItemId: matches[0].cartItemId, itemId, quantity, options: unchanged ? retainedOptions(fromCart) : apiOptions(options), ...(typeof matches[0].customerNote === 'string' ? { customerNote: matches[0].customerNote } : {}) });
          }
        }
      }
      assert(review, 'Escolha um item para preparar o carrinho.');
      const deliveryData = await gateway.call('getCartDeliveryMethods', { cartId: review.cartId });
      review.deliveryMethods = deliveries(deliveryData);
      if (request.deliveryMethodId) {
        const method = review.deliveryMethods.find(d => d.id === request.deliveryMethodId);
        assert(method, 'Escolha uma entrega disponível.');
        if (request.timeSlotId) assert(method.timeSlots?.some(s => s.id === request.timeSlotId), 'Horário de entrega inválido.');
        await gateway.call('setCartDelivery', { cartId: review.cartId, deliveryMethodId: method.id, ...(request.timeSlotId ? { selectedTimeSlotId: request.timeSlotId } : {}) });
        review.deliveryMethodId = method.id; review.timeSlotId = request.timeSlotId;
        record.cartDeliverySnapshot = undefined;
      }
      const paymentData = body(await gateway.call('listPaymentMethods', { merchantId: review.merchantId }));
      const pix = array(paymentData?.paymentMethods ?? paymentData?.methods ?? paymentData).find(p => p.kind === 'PIX' && typeof p.paymentMethodId === 'string');
      if (pix) {
        await gateway.call('setCartPayment', { cartId: review.cartId, paymentMethodId: pix.paymentMethodId });
        review.paymentMethodId = pix.paymentMethodId;
      } else review.paymentMethodId = undefined;
      try { review.vouchers = vouchers(await gateway.call('listVouchers', { cartId: review.cartId })); }
      catch (error) { if (request.voucher) throw error; review.vouchers = []; }
      if (request.voucher) {
        assert(review.vouchers.some(v => v.code === request.voucher!.code && v.campaignId === request.voucher!.campaignId), 'Este cupom não foi oferecido para o carrinho.');
        await gateway.call('setVoucher', { cartId: review.cartId, code: request.voucher.code, campaignId: request.voucher.campaignId });
        review.selectedVoucher = request.voucher.code;
      } else if (request.voucher === null) {
        await gateway.call('removeVoucher', { cartId: review.cartId }); review.selectedVoucher = undefined;
      }
      const raw = await gateway.call('getCart', { cartId: review.cartId });
      review = normalizeReview(raw, { ...review, version: review.version + 1 }, record);
      if (!pix) { review.ready = false; review.blockers.push('Esta loja não oferece Pix pelo iFood.'); }
      record.review = review; record.reviewSnapshot = cartSnapshot(raw);
      this.store.saveConversation(owner, record);
      return review;
    });
  }

  async confirm(owner: string, gateway: ToolGateway, record: ConversationRecord, input: { reviewId?: string; version?: number; userConsent?: boolean }): Promise<OrderReceipt> {
    const review = record.review;
    assert(review && input.reviewId === review.id, 'Revisão não encontrada. Prepare o carrinho novamente.', 409);
    assert(input.userConsent === true, 'Confirme explicitamente o envio do pedido.', 400, 'CONSENT_REQUIRED');
    const previous = this.store.attempt(owner, review.cartId);
    if (previous?.receipt) return previous.receipt;
    if (previous) throw new AppError('O envio deste carrinho está em verificação. Confira também sua conta iFood. Não enviaremos novamente.', 409, 'ORDER_UNKNOWN');
    return this.locks.run(`${owner}:${record.id}`, async () => {
      const attempt = this.store.attempt(owner, review.cartId);
      if (attempt?.receipt) return attempt.receipt;
      if (attempt) throw new AppError('O envio deste carrinho está em verificação. Confira sua conta iFood.', 409, 'ORDER_UNKNOWN');
      assert(input.version === review.version, 'O carrinho mudou. Revise os valores atuais.', 409, 'REVIEW_CHANGED', { review });
      assert(review.ready, 'Resolva as pendências do carrinho antes de confirmar.', 409, 'CART_NOT_READY', { review });
      const raw = await gateway.call('getCart', { cartId: review.cartId });
      const current = normalizeReview(raw, review, record);
      try { assertPix(raw, review.paymentMethodId); }
      catch {
        record.review = { ...current, version: review.version + 1 }; record.reviewSnapshot = cartSnapshot(raw);
        this.store.saveConversation(owner, record);
        throw new AppError('O pagamento do carrinho mudou. Revise para confirmar exclusivamente Pix.', 409, 'PIX_REQUIRED', { review: record.review });
      }
      if (cartSnapshot(raw) !== record.reviewSnapshot || !current.ready) {
        record.review = { ...current, version: review.version + 1 }; record.reviewSnapshot = cartSnapshot(raw);
        this.store.saveConversation(owner, record);
        throw new AppError('O carrinho foi atualizado pelo iFood. Confira os novos valores e confirme novamente.', 409, 'REVIEW_CHANGED', { review: record.review });
      }
      assert(this.store.beginAttempt(owner, review.cartId), 'Este pedido já está em verificação.', 409, 'ORDER_UNKNOWN');
      try {
        const result = body(await gateway.call('submitOrder', { cartId: review.cartId, userConsent: true }));
        assert(typeof result?.orderId === 'string' && result.orderId.length > 0, 'O iFood não retornou o identificador do pedido.', 502, 'ORDER_UNKNOWN');
        const receipt: OrderReceipt = { id: result.orderId, cartId: review.cartId, merchantName: review.merchantName, createdAt: new Date().toISOString(), total: review.totals.total };
        this.store.completeAttempt(owner, review.cartId, receipt);
        return receipt;
      } catch (error) {
        this.store.unknownAttempt(owner, review.cartId);
        throw new AppError('Não foi possível confirmar o resultado do envio. Confira sua conta iFood; este carrinho não será reenviado automaticamente.', 409, 'ORDER_UNKNOWN');
      }
    });
  }
}
