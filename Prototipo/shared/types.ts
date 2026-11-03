export interface VisionResult {
  productName: string | null;
  details: string;
  searchQueries: string[];
  needsClarification: boolean;
}
export interface Address {
  id: string;
  label: string;
  formatted: string;
  latitude: number;
  longitude: number;
}
export type MerchantType = 'RESTAURANT' | 'GROCERIES' | 'DRUGSTORE' | 'PETSTORE' | 'LIQUORSTORE' | 'SHOPPING';
export interface Offer {
  id: string;
  merchantId: string;
  itemId?: string;
  merchantName: string;
  name: string;
  description?: string;
  imageUrl?: string;
  price?: number;
  deliveryFee?: number;
  deliveryMinutes?: number;
  deliveryLabel?: string;
  minimumOrder?: number;
  merchantType?: MerchantType;
  quote?: OfferQuote;
}
export interface OfferQuote {
  status: 'quoting' | 'ready' | 'needs_options' | 'unavailable';
  addressId: string;
  quotedAt?: string;
  quotedTotal?: number;
  totals?: CartTotals;
  availableVouchers: Voucher[];
  appliedVoucher?: Voucher;
  delivery?: DeliveryMethod;
  blockers: string[];
}
export interface ItemOption { id: string; name: string; price?: number; }
export interface OptionGroup { id: string; name: string; min: number; max: number; options: ItemOption[]; }
export interface ItemDetails {
  merchantId: string;
  itemId: string;
  name: string;
  description?: string;
  price?: number;
  imageUrl?: string;
  optionGroups: OptionGroup[];
}
export interface SelectedOption { groupId: string; optionId: string; quantity: number; }
export interface CartLine {
  itemId: string;
  cartItemId?: string;
  name: string;
  quantity: number;
  options: SelectedOption[];
  optionLabels?: string[];
  price?: number;
  total?: number;
}
export interface DeliveryMethod {
  id: string;
  name: string;
  mode?: string;
  fee?: number;
  description?: string;
  timeSlots?: { id: string; label: string }[];
}
export interface Voucher { code: string; campaignId: string; title: string; }
export interface CartTotals {
  subtotal?: number;
  deliveryFee?: number;
  serviceFee?: number;
  discount?: number;
  benefitsDiscount?: number;
  voucherDiscount?: number;
  total?: number;
  minimumOrder?: number;
}
export interface CartReview {
  id: string;
  version: number;
  cartId: string;
  merchantId: string;
  merchantName: string;
  address: Address;
  items: CartLine[];
  deliveryMethods: DeliveryMethod[];
  deliveryMethodId?: string;
  timeSlotId?: string;
  paymentMethodId?: string;
  paymentKind?: 'PIX';
  vouchers: Voucher[];
  selectedVoucher?: string;
  totals: CartTotals;
  blockers: string[];
  ready: boolean;
}
export interface OrderReceipt {
  id: string;
  cartId: string;
  merchantName: string;
  createdAt: string;
  total?: number;
  status?: { code: string; description: string };
  details?: unknown;
  pollingStop?: boolean;
  retryAfterSeconds?: number;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: string;
  imageName?: string;
}
export interface Conversation {
  id: string;
  messages: ChatMessage[];
  offers: Offer[];
  vision?: VisionResult;
  review?: CartReview;
}
export interface SessionState {
  connected: boolean;
  configured: boolean;
  geminiConfigured: boolean;
  userName?: string;
  addresses: Address[];
  selectedAddressId?: string;
  orders: OrderReceipt[];
  capabilities: string[];
}
export type ChatEvent =
  | { type: 'progress'; text: string }
  | { type: 'state'; conversation: Conversation }
  | { type: 'error'; message: string; code?: string }
  | { type: 'done' };
export interface ReviewRequest {
  conversationId: string;
  cartItemId?: string;
  offerId?: string;
  itemId?: string;
  quantity?: number;
  options?: SelectedOption[];
  deliveryMethodId?: string;
  timeSlotId?: string;
  voucher?: { code: string; campaignId: string } | null;
  addItem?: boolean;
}
