import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Camera, CheckCircle2, ChevronRight, Clock3, Home, ImagePlus, LoaderCircle, LogOut, MapPin, MessageCircle, Minus, Plus, RefreshCw, Search, Send, ShoppingBag, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react';
import type { CartReview, ChatEvent, Conversation, ItemDetails, MerchantType, Offer, OrderReceipt, ReviewRequest, SelectedOption, SessionState } from '../shared/types';

type Photo = { base64: string; mimeType: string; name: string; url: string };
type AddressCandidate = { id: string; label?: string; formatted?: string };
type Sort = 'RELEVANCE' | 'PRICE' | 'DELIVERY_TIME';
type ApiError = Error & { data?: { review?: CartReview; message?: string; error?: string; code?: string; candidates?: AddressCandidate[] }; status?: number };
const money = (value?: number) => value === undefined ? 'A consultar' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
const categories: { value: MerchantType | ''; label: string }[] = [{ value: '', label: 'Todos os lugares' }, { value: 'RESTAURANT', label: 'Restaurantes' }, { value: 'GROCERIES', label: 'Mercados' }, { value: 'DRUGSTORE', label: 'Farmácias' }, { value: 'PETSTORE', label: 'Pet shops' }, { value: 'LIQUORSTORE', label: 'Bebidas' }, { value: 'SHOPPING', label: 'Lojas' }];

// Keep one pending photo on this device while the user completes the iFood login.
async function photoDraft(action: 'read' | 'write' | 'delete', photo?: Photo): Promise<Photo | null> {
  let database: IDBDatabase | undefined;
  try {
    database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('viu-pediu-draft', 1);
      opening.onupgradeneeded = () => { if (!opening.result.objectStoreNames.contains('photo')) opening.result.createObjectStore('photo'); };
      opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
    });
    return await new Promise<Photo | null>((resolve, reject) => {
      const transaction = database!.transaction('photo', action === 'read' ? 'readonly' : 'readwrite');
      const storage = transaction.objectStore('photo');
      let result: Photo | null = null;
      if (action === 'read') {
        const read = storage.get('pending');
        read.onsuccess = () => { const value = read.result; if (value && typeof value.url === 'string' && typeof value.savedAt === 'number' && Date.now() - value.savedAt < 3_600_000 && ['image/jpeg', 'image/png', 'image/webp'].includes(value.mimeType)) result = { url: value.url, base64: value.url.split(',')[1], mimeType: value.mimeType, name: value.name }; };
      } else if (action === 'write' && photo) storage.put({ url: photo.url, mimeType: photo.mimeType, name: photo.name, savedAt: Date.now() }, 'pending');
      else storage.delete('pending');
      transaction.oncomplete = () => resolve(result); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
    });
  } catch { return null; } finally { database?.close(); }
}

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error: ApiError = new Error(data.message || (typeof data.error === 'string' ? data.error : undefined) || 'Não foi possível concluir. Tente novamente.');
    if (response.status === 401 && url !== '/api/session') window.dispatchEvent(new Event('viu-session-refresh'));
    error.data = data; error.status = response.status; throw error;
  }
  return data;
}

function Brand() { return <span className="brand" aria-label="Viu, pediu.">Viu, pediu</span>; }

function BottomNav({ screen, onNavigate }: { screen: 'home' | 'camera' | 'chat'; onNavigate: (screen: 'home' | 'chat') => void }) {
  return <nav className="bottom-nav" aria-label="Navegação principal"><button className={screen === 'home' ? 'active' : ''} onClick={() => onNavigate('home')} aria-current={screen === 'home' ? 'page' : undefined}><Home size={19} strokeWidth={2} /><span>Início</span></button><button className={screen === 'chat' ? 'active' : ''} onClick={() => onNavigate('chat')} aria-current={screen === 'chat' ? 'page' : undefined}><MessageCircle size={19} strokeWidth={2} /><span>Chat</span></button></nav>;
}

function Modal({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key !== 'Tab' || !panel.current) return;
      const nodes = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter(node => node.offsetParent !== null);
      if (!nodes.length) { event.preventDefault(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-heading" tabIndex={-1} ref={panel}><header className="modal-header"><div><h2 id="modal-heading">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Fechar"><X size={21} /></button></header>{children}</div></div>;
}

function CameraScreen({ onCapture, onGallery, onMenu }: { onCapture: (photo: Photo) => void; onGallery: () => void; onMenu: () => void }) {
  const video = useRef<HTMLVideoElement>(null), stream = useRef<MediaStream | null>(null);
  const [error, setError] = useState(''), [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    if (!navigator.mediaDevices?.getUserMedia) { setError('A câmera não está disponível neste navegador. Envie uma foto da galeria.'); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }).then(async media => {
      if (!active) { media.getTracks().forEach(track => track.stop()); return; }
      stream.current = media;
      if (video.current) { video.current.srcObject = media; await video.current.play(); }
    }).catch(() => { if (active) setError('Não foi possível abrir a câmera. Permita o acesso no navegador ou envie uma foto da galeria.'); });
    return () => { active = false; stream.current?.getTracks().forEach(track => track.stop()); };
  }, []);
  const capture = () => {
    if (!video.current?.videoWidth) return;
    const canvas = document.createElement('canvas'), scale = Math.min(1, 1800 / Math.max(video.current.videoWidth, video.current.videoHeight));
    canvas.width = Math.round(video.current.videoWidth * scale); canvas.height = Math.round(video.current.videoHeight * scale);
    const context = canvas.getContext('2d'); if (!context) { setError('Não foi possível capturar a foto. Envie pela galeria.'); return; }
    context.drawImage(video.current, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', 0.88);
    onCapture({ url, base64: url.split(',')[1], mimeType: 'image/jpeg', name: `Foto ${new Date().toLocaleTimeString('pt-BR')}.jpg` });
  };
  return <section className="camera-screen" aria-label="Câmera"><video ref={video} playsInline muted onLoadedData={() => setReady(true)} aria-label="Prévia da câmera" /><header className="screen-header camera-header"><Brand /><button className="menu-button" onClick={onMenu} aria-label="Menu"><span /><span /></button></header>{error ? <div className="camera-unavailable" role="status"><Camera size={42} strokeWidth={1.4} /><p>{error}</p><button className="camera-fallback" onClick={onGallery}>Escolher uma foto</button></div> : !ready ? <div className="camera-starting" role="status"><LoaderCircle className="spin" size={27} /><span>Abrindo sua câmera…</span></div> : null}<div className="camera-controls"><button className="gallery-button" onClick={onGallery} aria-label="Enviar foto da galeria"><ImagePlus size={24} /></button><button className="shutter-button" onClick={capture} disabled={!ready || !!error} aria-label="Fotografar"><span /></button><span className="camera-control-spacer" /></div></section>;
}

function ProductImage({ src, name, className = '' }: { src?: string; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <div className={`product-image ${className}`}>{src && !failed ? <img src={src} alt={name} loading="lazy" onError={() => setFailed(true)} /> : <ShoppingBag size={29} strokeWidth={1.4} aria-hidden="true" />}</div>;
}

function ItemPicker({ offer, items, pending, error, onClose, onSelect }: { offer: Offer; items: ItemDetails[]; pending: boolean; error: string; onClose: () => void; onSelect: (item: ItemDetails, quantity: number, options: SelectedOption[]) => void }) {
  const [selected, setSelected] = useState(offer.itemId || (items.length === 1 ? items[0].itemId : ''));
  const [quantity, setQuantity] = useState(1), [options, setOptions] = useState<SelectedOption[]>([]);
  const item = items.find(candidate => candidate.itemId === selected);
  const valid = item?.optionGroups.every(group => { const count = options.filter(option => option.groupId === group.id).reduce((sum, option) => sum + option.quantity, 0); return count >= group.min && count <= group.max; });
  const chooseItem = (id: string) => { setSelected(id); setOptions([]); setQuantity(1); };
  const changeOption = (groupId: string, optionId: string, next: number) => setOptions(previous => [...previous.filter(option => option.groupId !== groupId || option.optionId !== optionId), ...(next > 0 ? [{ groupId, optionId, quantity: next }] : [])]);
  return <Modal title={items.length > 1 && !item ? 'O que chamou sua atenção?' : item?.name || offer.name} subtitle={offer.merchantName} onClose={onClose} wide><div className="modal-body item-picker">
    {items.length > 1 && <div className="item-choices">{items.map(candidate => <button key={candidate.itemId} className={`item-choice ${selected === candidate.itemId ? 'selected' : ''}`} onClick={() => chooseItem(candidate.itemId)} disabled={pending}><ProductImage src={candidate.imageUrl} name={candidate.name} /><span><strong>{candidate.name}</strong><small>{money(candidate.price)}</small></span>{selected === candidate.itemId ? <CheckCircle2 size={20} /> : <ChevronRight size={20} />}</button>)}</div>}
    {item && <><div className="item-intro"><ProductImage src={item.imageUrl || offer.imageUrl} name={item.name} /><div><h3>{item.name}</h3>{item.description && <p>{item.description}</p>}<strong>{money(item.price)}</strong></div></div>{item.optionGroups.map(group => { const count = options.filter(option => option.groupId === group.id).reduce((sum, option) => sum + option.quantity, 0); return <fieldset className="option-group" key={group.id}><legend>{group.name}<small>{group.min > 0 ? `Escolha de ${group.min} a ${group.max}` : `Até ${group.max} opções`}<span className={count < group.min ? 'required' : ''}>{group.min > 0 ? 'Obrigatório' : 'Opcional'}</span></small></legend>{group.options.map(option => { const current = options.find(value => value.groupId === group.id && value.optionId === option.id)?.quantity || 0; return <div className="option-row" key={option.id}><span>{option.name}{option.price !== undefined && <small>{option.price > 0 ? `+ ${money(option.price)}` : 'Sem acréscimo'}</small>}</span><div className="stepper"><button aria-label={`Remover ${option.name}`} disabled={pending || current === 0} onClick={() => changeOption(group.id, option.id, current - 1)}><Minus size={14} /></button><output>{current}</output><button aria-label={`Adicionar ${option.name}`} disabled={pending || count >= group.max} onClick={() => changeOption(group.id, option.id, current + 1)}><Plus size={14} /></button></div></div>; })}</fieldset>; })}</>}
    {!items.length && <div className="empty-state"><ShoppingBag size={28} /><h3>Nenhum item disponível</h3><p>Volte para a conversa para buscar outra opção.</p></div>}{error && <div className="notice notice-error" role="alert">{error}</div>}
  </div><div className="modal-footer item-footer"><div className="stepper stepper-large"><button aria-label="Diminuir quantidade" disabled={pending || quantity <= 1} onClick={() => setQuantity(value => value - 1)}><Minus size={16} /></button><output aria-label="Quantidade">{quantity}</output><button aria-label="Aumentar quantidade" disabled={pending || quantity >= 99} onClick={() => setQuantity(value => value + 1)}><Plus size={16} /></button></div><button className="button button-primary" disabled={!item || !valid || pending} onClick={() => item && onSelect(item, quantity, options)}>{pending ? <LoaderCircle className="spin" size={17} /> : <ShoppingBag size={17} />}Revisar pedido<ArrowRight size={17} /></button></div></Modal>;
}

function Checkout({ review, pending, error, submissionBlocked, onClose, onUpdate, onConfirm }: { review: CartReview; pending: boolean; error: string; submissionBlocked: boolean; onClose: () => void; onUpdate: (patch: Partial<ReviewRequest>) => void; onConfirm: () => void }) {
  const [consent, setConsent] = useState(false);
  useEffect(() => setConsent(false), [review.version]);
  const delivery = review.deliveryMethods.find(method => method.id === review.deliveryMethodId);
  return <Modal title="Quase na sua porta" subtitle="Confira os detalhes antes de fazer o pedido." onClose={onClose} wide><div className="modal-body checkout-body">
    <div className="checkout-store"><span className="round-icon"><ShoppingBag size={21} /></span><div><small>Seu pedido em</small><h3>{review.merchantName}</h3></div></div>
    <div className="checkout-section"><h3>Na sua sacola</h3>{review.items.map((item, index) => <div className="cart-line" key={item.cartItemId || `${item.itemId}-${index}`}><div><strong>{item.name}</strong>{item.optionLabels?.length ? <span className="cart-options">{item.optionLabels.join(' · ')}</span> : null}<small>{item.total !== undefined ? money(item.total) : item.price !== undefined ? `${money(item.price)} / un.` : 'Valor a consultar'}</small></div><div className="stepper"><button disabled={pending} aria-label={`Diminuir ${item.name}`} onClick={() => onUpdate({ itemId: item.itemId, cartItemId: item.cartItemId, quantity: Math.max(0, item.quantity - 1), options: item.options, addItem: false })}>{item.quantity === 1 ? <Trash2 size={14} /> : <Minus size={14} />}</button><output>{item.quantity}</output><button disabled={pending || item.quantity >= 99} aria-label={`Aumentar ${item.name}`} onClick={() => onUpdate({ itemId: item.itemId, cartItemId: item.cartItemId, quantity: item.quantity + 1, options: item.options, addItem: false })}><Plus size={14} /></button></div></div>)}</div>
    <div className="checkout-section"><h3><MapPin size={17} /> Entregar em</h3><p className="address-copy">{review.address.formatted}</p></div>
    <fieldset className="checkout-section delivery-options"><legend>Como vai chegar</legend>{review.deliveryMethods.length ? review.deliveryMethods.map(method => <label key={method.id} className={`delivery-choice ${review.deliveryMethodId === method.id ? 'selected' : ''}`}><input type="radio" name="delivery" checked={review.deliveryMethodId === method.id} disabled={pending} onChange={() => onUpdate({ deliveryMethodId: method.id })} /><span><strong>{method.name}</strong>{method.description && <small>{method.description}</small>}</span><b>{money(method.fee)}</b></label>) : <p className="muted">Aguardando opções de entrega da loja.</p>}{delivery?.timeSlots?.length ? <label className="field-label">Horário da entrega<select value={review.timeSlotId || ''} disabled={pending} onChange={event => onUpdate({ deliveryMethodId: delivery.id, timeSlotId: event.target.value })}><option value="">Selecione um horário</option>{delivery.timeSlots.map(slot => <option key={slot.id} value={slot.id}>{slot.label}</option>)}</select></label> : null}</fieldset>
    <div className="checkout-section"><h3>Cupom</h3><label className="sr-only" htmlFor="voucher">Escolher cupom disponível</label><select id="voucher" value={review.selectedVoucher || ''} disabled={pending} onChange={event => { const voucher = review.vouchers.find(value => value.code === event.target.value); onUpdate({ voucher: voucher ? { code: voucher.code, campaignId: voucher.campaignId } : null }); }}><option value="">Sem cupom</option>{review.vouchers.map(voucher => <option value={voucher.code} key={`${voucher.code}-${voucher.campaignId}`}>{voucher.title} · {voucher.code}</option>)}</select></div>
    <div className="checkout-section"><h3>Pagamento</h3><div className="pix-method"><span className="pix-symbol" aria-hidden="true">◇</span><div><strong>Pix</strong><small>{review.paymentKind === 'PIX' && review.paymentMethodId ? 'Selecionado para este pedido' : 'Pix ainda não confirmado para este carrinho'}</small></div>{review.paymentKind === 'PIX' && review.paymentMethodId && <CheckCircle2 size={19} />}</div></div>
    <div className="checkout-totals"><div><span>Itens</span><span>{money(review.totals.subtotal)}</span></div><div><span>Entrega</span><span>{money(review.totals.deliveryFee)}</span></div><div><span>Taxa de serviço</span><span>{money(review.totals.serviceFee)}</span></div>{review.totals.benefitsDiscount !== undefined && review.totals.benefitsDiscount > 0 && <div className="discount"><span>Benefícios</span><span>− {money(review.totals.benefitsDiscount)}</span></div>}{review.totals.voucherDiscount !== undefined && review.totals.voucherDiscount > 0 && <div className="discount"><span>Cupom aplicado</span><span>− {money(review.totals.voucherDiscount)}</span></div>}{review.totals.discount !== undefined && review.totals.discount > 0 && <div className="discount"><span>Desconto informado pela loja</span><span>− {money(review.totals.discount)}</span></div>}<div className="total"><strong>Total</strong><strong>{money(review.totals.total)}</strong></div></div>
    {review.blockers.length > 0 && <div className="notice notice-warning" role="status"><strong>Ainda falta um detalhe</strong><ul>{review.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>{review.totals.minimumOrder !== undefined && <p>Pedido mínimo da loja: {money(review.totals.minimumOrder)}.</p>}</div>}{error && <div className="notice notice-error" role="alert">{error}</div>}
    {submissionBlocked && <div className="notice notice-warning" role="status">Este envio está em verificação. Confira seus pedidos na conta iFood. Esta sacola não será enviada de novo.</div>}
    <label className="consent"><input type="checkbox" checked={consent} disabled={pending || !review.ready || submissionBlocked} onChange={event => setConsent(event.target.checked)} /><span>Conferi os itens, o endereço e o total. Quero fazer este pedido real no iFood.</span></label>
  </div><div className="modal-footer checkout-footer"><div><small>Total do pedido</small><strong>{money(review.totals.total)}</strong></div><button className="button button-primary" disabled={pending || !review.ready || review.blockers.length > 0 || !consent || submissionBlocked} onClick={onConfirm}>{pending ? <LoaderCircle className="spin" size={18} /> : <ShoppingBag size={18} />} Confirmar e enviar ao iFood</button></div></Modal>;
}

export default function App() {
  const [session, setSession] = useState<SessionState | null>(null), [conversation, setConversation] = useState<Conversation | null>(null);
  const [booting, setBooting] = useState(true), [error, setError] = useState(''), [text, setText] = useState('');
  const [photo, setPhoto] = useState<Photo | null>(null), [photoSent, setPhotoSent] = useState(false);
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState('');
  const [screen, setScreen] = useState<'home' | 'camera' | 'chat'>('home'), [menuOpen, setMenuOpen] = useState(false), [pendingPhotoSearch, setPendingPhotoSearch] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false), [addressText, setAddressText] = useState(''), [complement, setComplement] = useState('');
  const [addressCandidates, setAddressCandidates] = useState<AddressCandidate[]>([]), [addressError, setAddressError] = useState(''), [addressBusy, setAddressBusy] = useState(false);
  const [selectedOffer, setSelectedOffer] = useState<Offer | null>(null), [items, setItems] = useState<ItemDetails[]>([]), [itemLoading, setItemLoading] = useState('');
  const [checkoutOpen, setCheckoutOpen] = useState(false), [checkoutBusy, setCheckoutBusy] = useState(false), [checkoutError, setCheckoutError] = useState('');
  const [uncertainCarts, setUncertainCarts] = useState<string[]>(() => { try { const ids: unknown = JSON.parse(sessionStorage.getItem('viu-pediu-pending-carts') || '[]'); return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []; } catch { return []; } });
  const [receipt, setReceipt] = useState<OrderReceipt | null>(null), [receiptOpen, setReceiptOpen] = useState(false), [ordersOpen, setOrdersOpen] = useState(false);
  const [sort, setSort] = useState<Sort>('RELEVANCE'), [merchantType, setMerchantType] = useState<MerchantType | ''>('');
  const fileInput = useRef<HTMLInputElement>(null), composer = useRef<HTMLTextAreaElement>(null), chatBottom = useRef<HTMLDivElement>(null), chatPanel = useRef<HTMLElement>(null);
  const requestAbort = useRef<AbortController | null>(null), busyRef = useRef(false), checkoutRef = useRef(false), uploadVersion = useRef(0);
  const selectedAddress = session?.addresses.find(address => address.id === session.selectedAddressId);

  const load = useCallback(async () => {
    setBooting(true); setError('');
    try {
      let id = ''; try { id = localStorage.getItem('viu-pediu-conversation') || ''; } catch { /* Optional storage. */ }
      const chatRequest = request<Conversation>(`/api/chat${id ? `?conversationId=${encodeURIComponent(id)}` : ''}`).catch(reason => { if ((reason as ApiError).status === 404 && id) return request<Conversation>('/api/chat'); throw reason; });
      const [state, chat] = await Promise.all([request<SessionState>('/api/session'), chatRequest]);
      setSession(state); setConversation(chat);
      try { localStorage.setItem('viu-pediu-conversation', chat.id); } catch { /* Optional storage. */ }
    } catch (reason) { setError((reason as Error).message); } finally { setBooting(false); }
  }, []);
  useEffect(() => { void load(); return () => requestAbort.current?.abort(); }, [load]);
  useEffect(() => { let active = true; void photoDraft('read').then(draft => { if (active && draft && uploadVersion.current === 0) { setPhoto(draft); setPhotoSent(false); setPendingPhotoSearch(true); setScreen('chat'); } }); return () => { active = false; }; }, []);
  useEffect(() => {
    const refresh = () => { void request<SessionState>('/api/session').then(setSession).catch(() => { /* Keep the last known state on a transport failure. */ }); };
    window.addEventListener('viu-session-refresh', refresh);
    return () => window.removeEventListener('viu-session-refresh', refresh);
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => { document.documentElement.style.setProperty('--visible-height', `${viewport?.height || window.innerHeight}px`); };
    update(); viewport?.addEventListener('resize', update);
    return () => { viewport?.removeEventListener('resize', update); document.documentElement.style.removeProperty('--visible-height'); };
  }, []);
  useEffect(() => { chatBottom.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [conversation?.messages.length, progress]);
  useEffect(() => {
    if (!receipt || receipt.pollingStop) return;
    let active = true;
    const timer = window.setTimeout(() => {
      request<OrderReceipt>(`/api/orders/${encodeURIComponent(receipt.id)}`).then(updated => { if (active) { setReceipt(updated); setSession(previous => previous ? { ...previous, orders: [updated, ...previous.orders.filter(order => order.id !== updated.id)] } : previous); } }).catch(() => { if (active) setReceipt(previous => previous ? { ...previous, retryAfterSeconds: Math.max(15, previous.retryAfterSeconds || 15) } : previous); });
    }, Math.max(3, receipt.retryAfterSeconds || 10) * 1000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [receipt]);
  const acceptPhoto = useCallback(async (file: File) => {
    if (busyRef.current) return;
    setScreen('chat');
    const version = ++uploadVersion.current;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setError('Escolha uma imagem JPG, PNG ou WEBP.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('Essa foto é grande demais. Escolha uma imagem de até 10 MB.'); return; }
    setError('');
    try {
      const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Não foi possível ler a foto. Tente outra imagem.')); reader.readAsDataURL(file); });
      if (version !== uploadVersion.current || busyRef.current) return;
      const image = { url, base64: url.split(',')[1], mimeType: file.type, name: file.name }; await photoDraft('write', image);
      if (version !== uploadVersion.current) return;
      setPhoto(image); setPhotoSent(false); setScreen('chat'); setPendingPhotoSearch(true);
    } catch (reason) { setError((reason as Error).message); }
  }, []);
  useEffect(() => {
    const paste = (event: ClipboardEvent) => { const image = Array.from(event.clipboardData?.items || []).find(item => item.type.startsWith('image/'))?.getAsFile(); if (image && !document.querySelector('[role="dialog"]')) { event.preventDefault(); void acceptPhoto(image); } };
    window.addEventListener('paste', paste); return () => window.removeEventListener('paste', paste);
  }, [acceptPhoto]);

  const send = async (message = text, image: Photo | null = !photoSent ? photo : null, nextSort = sort, nextMerchant = merchantType) => {
    if (busyRef.current || !conversation || (!message.trim() && !image && !conversation.vision && !conversation.offers.length)) return;
    if (!session?.connected) { setError('Conecte sua conta iFood para buscar opções perto de você.'); return; }
    if (!session.selectedAddressId) { setAddressOpen(true); return; }
    busyRef.current = true; setBusy(true); setProgress(image ? 'Olhando os detalhes da sua foto…' : 'Buscando as melhores opções para você…'); setError(''); setText('');
    const controller = new AbortController(); requestAbort.current = controller;
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, signal: controller.signal, body: JSON.stringify({ conversationId: conversation.id, text: message.trim() || undefined, imageBase64: image?.base64, mimeType: image?.mimeType, imageName: image?.name, sort: nextSort, merchantType: nextMerchant || undefined }) });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.message || data.error || 'Não foi possível conversar agora. Tente novamente.'); }
      if (!response.body) throw new Error('A conexão foi interrompida. Tente novamente.');
      if (image) setPhotoSent(true);
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', gotState = false, hadError = false;
      const applyEvent = (block: string) => {
        const payload = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!payload || payload === '[DONE]') return;
        let event: ChatEvent; try { event = JSON.parse(payload); } catch { return; }
        if (event.type === 'progress') setProgress(event.text);
        if (event.type === 'state') { setConversation(event.conversation); gotState = true; if (event.conversation.review && (event.conversation.review.id !== conversation.review?.id || event.conversation.review.version !== conversation.review?.version)) { setCheckoutOpen(true); setCheckoutError(''); } }
        if (event.type === 'error') { hadError = true; setError(event.message); if (image) setPhotoSent(false); }
      };
      while (true) {
        const { value, done } = await reader.read(); buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
        let boundary; while ((boundary = buffer.indexOf('\n\n')) !== -1) { applyEvent(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
        if (done) { if (buffer.trim()) applyEvent(buffer); break; }
      }
      if (image && !hadError) void photoDraft('delete');
      if (!gotState) setConversation(await request<Conversation>(`/api/chat?conversationId=${encodeURIComponent(conversation.id)}`));
    } catch (reason) { if ((reason as Error).name !== 'AbortError') { setError((reason as Error).message); if (image) setPhotoSent(false); setText(message); } }
    finally { busyRef.current = false; setBusy(false); setProgress(''); requestAbort.current = null; void request<SessionState>('/api/session').then(setSession).catch(() => { /* The next interaction can refresh the session again. */ }); }
  };
  const newConversation = async () => {
    if (busyRef.current || checkoutRef.current) return;
    try { const chat = await request<Conversation>('/api/chat/new', {}); uploadVersion.current++; void photoDraft('delete'); setConversation(chat); setPhoto(null); setPhotoSent(false); setPendingPhotoSearch(false); setScreen('chat'); setError(''); setText(''); setSort('RELEVANCE'); setMerchantType(''); try { localStorage.setItem('viu-pediu-conversation', chat.id); } catch { /* Optional storage. */ } composer.current?.focus(); } catch (reason) { setError((reason as Error).message); }
  };
  const saveAddress = async (body: unknown) => {
    setAddressBusy(true); setAddressError('');
    try {
      const result = await request<SessionState & { candidates?: AddressCandidate[] }>('/api/session/address', body);
      if (result.candidates?.length) { setAddressCandidates(result.candidates); return; }
      setSession(result.addresses ? result : await request<SessionState>('/api/session')); setAddressOpen(false); setAddressCandidates([]);
    } catch (reason) { const problem = reason as ApiError; if (problem.data?.candidates?.length) setAddressCandidates(problem.data.candidates); else setAddressError(problem.message); }
    finally { setAddressBusy(false); }
  };
  const chooseOffer = async (offer: Offer) => {
    if (itemLoading || checkoutRef.current || busyRef.current || !conversation) return;
    setError(''); setCheckoutError(''); setItemLoading(offer.id);
    try { const data = await request<{ items: ItemDetails[] }>(`/api/items?conversationId=${encodeURIComponent(conversation.id)}&offerId=${encodeURIComponent(offer.id)}`); setItems(data.items); setSelectedOffer(offer); } catch (reason) { setError((reason as Error).message); } finally { setItemLoading(''); }
  };
  const updateReview = async (patch: Partial<ReviewRequest>) => {
    if (checkoutRef.current || !conversation) return;
    checkoutRef.current = true; setCheckoutBusy(true); setCheckoutError('');
    try { const review = await request<CartReview>('/api/checkout/review', { conversationId: conversation.id, ...patch }); setConversation(previous => previous ? { ...previous, review } : previous); setSelectedOffer(null); setCheckoutOpen(true); }
    catch (reason) { const problem = reason as ApiError; if (problem.data?.review) { const next = problem.data.review; setConversation(previous => previous ? { ...previous, review: next } : previous); setCheckoutOpen(true); setSelectedOffer(null); } setCheckoutError(problem.message); if (!checkoutOpen && !problem.data?.review) setError(problem.message); }
    finally { checkoutRef.current = false; setCheckoutBusy(false); }
  };
  const confirmOrder = async () => {
    if (checkoutRef.current || !conversation?.review || uncertainCarts.includes(conversation.review.cartId)) return;
    checkoutRef.current = true; setCheckoutBusy(true); setCheckoutError('');
    try { const result = await request<OrderReceipt>('/api/checkout/confirm', { conversationId: conversation.id, reviewId: conversation.review.id, version: conversation.review.version, userConsent: true }); setReceipt(result); setReceiptOpen(true); setCheckoutOpen(false); setSession(previous => previous ? { ...previous, orders: [result, ...previous.orders.filter(order => order.id !== result.id)] } : previous); setConversation(previous => previous ? { ...previous, review: undefined } : previous); }
    catch (reason) { const problem = reason as ApiError; if (problem.data?.review) { const next = problem.data.review; setConversation(previous => previous ? { ...previous, review: next } : previous); } if (problem.data?.code === 'ORDER_UNKNOWN' || !problem.status) { const ids = [...new Set([...uncertainCarts, conversation.review.cartId])]; setUncertainCarts(ids); try { sessionStorage.setItem('viu-pediu-pending-carts', JSON.stringify(ids)); } catch { /* Server also prevents duplicate submission. */ } } setCheckoutError(problem.message); }
    finally { checkoutRef.current = false; setCheckoutBusy(false); }
  };
  const logout = async () => { try { await request('/api/auth/ifood/logout', {}); setSession(await request<SessionState>('/api/session')); setConversation(await request<Conversation>('/api/chat')); setPhoto(null); setPhotoSent(false); setReceipt(null); } catch (reason) { setError((reason as Error).message); } };
  const capturePhoto = async (image: Photo) => { uploadVersion.current++; await photoDraft('write', image); setPhoto(image); setPhotoSent(false); setScreen('chat'); setPendingPhotoSearch(true); setError(''); };
  useEffect(() => { if (!pendingPhotoSearch || !photo || booting || !conversation || !session?.connected || busyRef.current) return; if (!session.selectedAddressId) { setAddressOpen(true); return; } setPendingPhotoSearch(false); void send('', photo); }, [pendingPhotoSearch, photo, booting, busy, conversation?.id, session?.connected, session?.selectedAddressId]);
  const hasConversation = !!conversation?.messages.length, offers = conversation?.offers || [];

  return <div className="app-stage"><div className={`app-shell phone-frame screen-${screen}`} aria-label="Viu, pediu" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void acceptPhoto(file); }}>
    <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1} aria-label="Enviar foto" onChange={event => { const file = event.target.files?.[0]; if (file) void acceptPhoto(file); event.target.value = ''; }} />
    {screen === 'home' && <main className="home-screen"><header className="screen-header"><Brand /><button className="menu-button" aria-label="Menu" onClick={() => setMenuOpen(true)}><span /><span /></button></header><h1>Bem-vindo!</h1><button className="home-camera" aria-label="Abrir câmera" onClick={() => setScreen('camera')}><Camera size={59} strokeWidth={1.8} /></button></main>}
    {screen === 'camera' && <CameraScreen onCapture={capturePhoto} onGallery={() => fileInput.current?.click()} onMenu={() => setMenuOpen(true)} />}
    {screen === 'chat' && <section className="chat-screen" id="conversation" ref={chatPanel} aria-label="Conversa e resultados"><header className="chat-header"><button className="icon-button" aria-label="Voltar ao início" onClick={() => setScreen('home')}><ArrowLeft size={21} /></button><div><strong>Viu, pediu</strong><small>{busy ? 'Buscando pra você…' : session?.connected && session.geminiConfigured ? 'Como posso ajudar?' : 'Chat'}</small></div><button className="menu-button" aria-label="Menu" onClick={() => setMenuOpen(true)}><span /><span /></button></header>
      <div className="conversation-content" aria-busy={busy || booting}>{booting ? <div className="boot-state"><LoaderCircle className="spin" size={25} /><p>Carregando sua conversa…</p></div> : <>
        {photo && !conversation?.messages.some(message => message.imageName === photo.name) && <div className="message-photo"><img src={photo.url} alt={`Foto enviada: ${photo.name}`} /></div>}
        {!session?.connected && <div className="connection-card"><strong>Vamos encontrar o que você viu?</strong><p>{session?.configured ? 'Conecte sua conta iFood para buscar e pedir perto de você.' : 'A conexão com o iFood está indisponível no momento. Sua foto fica pronta por aqui.'}</p>{session?.configured && <a href="/api/auth/ifood/start" className="button button-primary">Conectar iFood<ArrowRight size={16} /></a>}</div>}
        {session?.connected && !selectedAddress && <button className="address-prompt" onClick={() => setAddressOpen(true)}><MapPin size={17} /><span>Escolha o endereço de entrega</span><ChevronRight size={16} /></button>}
        {!hasConversation && !photo && <div className="chat-empty"><Camera size={34} strokeWidth={1.4} /><p>Mande uma foto.<br />A gente encontra pra você.</p></div>}
        {hasConversation && <div className="message-list" role="log" aria-label="Mensagens da conversa" aria-live="polite">{conversation?.messages.map(message => <div className={`message-group message-group-${message.role}`} key={message.id}>{message.imageName && photo?.name === message.imageName && <div className="message-photo"><img src={photo.url} alt={`Foto enviada: ${message.imageName}`} /></div>}<div className={`message message-${message.role}`}><div className="message-body">{message.imageName && photo?.name !== message.imageName && <span className="message-attachment"><ImagePlus size={14} />{message.imageName}</span>}{message.text && <p>{message.text}</p>}</div></div></div>)}</div>}
        {conversation?.vision?.productName && <div className="recognition-note"><CheckCircle2 size={14} /><span>Na sua foto: <strong>{conversation.vision.productName}</strong></span></div>}
        {offers.length > 0 && <section className="offers-section" aria-label="Opções encontradas"><div className="offers-filters"><label><SlidersHorizontal size={13} /><select aria-label="Ordenar opções" value={sort} disabled={busy} onChange={event => { const next = event.target.value as Sort; setSort(next); void send('', null, next, merchantType); }}><option value="RELEVANCE">Relevância</option><option value="PRICE">Menor preço</option><option value="DELIVERY_TIME">Mais rápido</option></select></label><label><select aria-label="Tipo de loja" value={merchantType} disabled={busy} onChange={event => { const next = event.target.value as MerchantType | ''; setMerchantType(next); void send('', null, sort, next); }}>{categories.map(category => <option key={category.value} value={category.value}>{category.label}</option>)}</select></label></div><div className="offer-list">{offers.map(offer => {
          const quote = offer.quote?.addressId === session?.selectedAddressId ? offer.quote : undefined;
          const total = quote?.status === 'ready' ? quote.quotedTotal ?? quote.totals?.total : undefined;
          const delivery = quote?.delivery?.description || offer.deliveryLabel || (offer.deliveryMinutes !== undefined ? `${offer.deliveryMinutes} min` : undefined);
          return <article className="offer-card" key={offer.id}><ProductImage src={offer.imageUrl} name={offer.name} /><div className="offer-info"><h2>{offer.name}</h2><p className="merchant-name"><ShoppingBag size={11} />{offer.merchantName}</p>{total !== undefined && offer.price !== undefined && <p className="offer-unit-price">Item {money(offer.price)}</p>}<div className="offer-meta">{delivery && <span><Clock3 size={11} />{delivery}</span>}{total === undefined && offer.deliveryFee !== undefined && <span>{offer.deliveryFee === 0 ? 'Frete grátis' : `Frete ${money(offer.deliveryFee)}`}</span>}</div>{quote?.appliedVoucher ? <p className="offer-voucher">{quote.appliedVoucher.title} · {quote.appliedVoucher.code}</p> : quote?.availableVouchers?.length ? <p className="offer-voucher">{quote.availableVouchers.length} {quote.availableVouchers.length === 1 ? 'cupom disponível' : 'cupons disponíveis'}</p> : null}{quote?.totals?.benefitsDiscount !== undefined && quote.totals.benefitsDiscount > 0 && <p className="offer-benefit">Benefícios − {money(quote.totals.benefitsDiscount)}</p>}<div className="offer-bottom"><div className="offer-price"><strong>{total !== undefined ? money(total) : offer.price === undefined ? 'Ver opções' : money(offer.price)}</strong><small>{total !== undefined ? 'Total com taxas' : 'Preço do item'}</small></div><button className="offer-select" disabled={busy || !!itemLoading || checkoutBusy} onClick={() => void chooseOffer(offer)}>{itemLoading === offer.id ? <LoaderCircle className="spin" size={15} /> : 'Comprar'}</button></div>{total === undefined && <p className="offer-quote-note">{quote?.status === 'quoting' ? 'Consultando total…' : quote?.status === 'needs_options' ? 'Total após escolher complementos' : 'Total conferido na sacola'}</p>}{quote?.blockers?.length ? <p className="offer-blocker">{quote.blockers[0]}</p> : null}</div></article>;
        })}</div></section>}
        {busy && <div className="thinking" role="status"><LoaderCircle className="spin" size={15} /><span>{progress || 'Só um instante…'}</span></div>}
        {error && <div className="notice notice-error app-error" role="alert"><span>{error}</span><button className="icon-button" aria-label="Fechar aviso" onClick={() => setError('')}><X size={14} /></button>{!session ? <button className="text-button" onClick={() => void load()}><RefreshCw size={14} />Tentar novamente</button> : photo && !photoSent && <button className="text-button" disabled={busy} onClick={() => void send('', photo)}><RefreshCw size={14} />Tentar novamente</button>}</div>}
        {receipt && !receiptOpen && <button className="receipt-inline" onClick={() => setReceiptOpen(true)}><CheckCircle2 size={19} /><span><strong>Seu pedido</strong><small>{receipt.merchantName} · {receipt.status?.description || 'Ver detalhes'}</small></span><ChevronRight size={17} /></button>}<div ref={chatBottom} />
      </>}</div>
      <div className="composer-area">{conversation?.review && <button className="cart-banner" onClick={() => { setCheckoutOpen(true); setCheckoutError(''); }}><span><ShoppingBag size={16} /><strong>Sua sacola</strong></span><span>{money(conversation.review.totals.total)}<ChevronRight size={16} /></span></button>}
        <form className="composer" onSubmit={(event: FormEvent) => { event.preventDefault(); void send(); }}><button type="button" className="composer-camera" aria-label="Abrir câmera" disabled={busy || booting} onClick={() => setScreen('camera')}><Camera size={22} /></button><label className="sr-only" htmlFor="message">Sua mensagem</label><textarea id="message" ref={composer} value={text} rows={1} onChange={event => { setText(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(94, event.target.scrollHeight)}px`; }} placeholder="Escreva aqui…" disabled={booting || busy} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><button type="submit" className="composer-send" aria-label="Enviar mensagem" disabled={busy || booting || (!text.trim() && (!photo || photoSent))}>{busy ? <LoaderCircle className="spin" size={18} /> : <Send size={19} />}</button></form>
      </div>
    </section>}
    <BottomNav screen={screen} onNavigate={setScreen} />
    {menuOpen && <Modal title="Viu, pediu" onClose={() => setMenuOpen(false)}><div className="modal-body menu-body"><div className="menu-account"><span className={`account-status ${session?.connected ? 'connected' : ''}`} /><div><strong>{session?.connected ? session.userName || 'Sua conta iFood' : 'Sua conta'}</strong><p>{session?.connected ? 'Conectada ao iFood' : 'Conecte para buscar e pedir'}</p></div></div>{!session?.connected && (session?.configured ? <a className="button button-primary menu-login" href="/api/auth/ifood/start">Conectar iFood<ArrowRight size={17} /></a> : <p className="muted menu-offline">A conexão com o iFood está indisponível no momento.</p>)}<button className="menu-row" disabled={!session?.connected} onClick={() => { setMenuOpen(false); setAddressError(''); setAddressOpen(true); }}><MapPin size={20} /><span><strong>Endereço de entrega</strong><small>{selectedAddress?.formatted || 'Escolher endereço'}</small></span><ChevronRight size={17} /></button><button className="menu-row" onClick={() => { setMenuOpen(false); setOrdersOpen(true); }}><ShoppingBag size={20} /><span><strong>Meus pedidos</strong><small>Acompanhe seus pedidos</small></span><ChevronRight size={17} /></button><button className="menu-row" disabled={busy || checkoutBusy || booting} onClick={() => { setMenuOpen(false); void newConversation(); }}><MessageCircle size={20} /><span><strong>Nova conversa</strong><small>Começar uma nova busca</small></span><Plus size={17} /></button>{session?.connected && <button className="menu-row menu-logout" disabled={busy || checkoutBusy} onClick={() => { setMenuOpen(false); void logout(); }}><LogOut size={19} /><span>Desconectar iFood</span></button>}</div></Modal>}
    {selectedOffer && <ItemPicker offer={selectedOffer} items={items} pending={checkoutBusy} error={checkoutError} onClose={() => { if (!checkoutBusy) setSelectedOffer(null); }} onSelect={(item, quantity, options) => void updateReview({ offerId: selectedOffer.id, itemId: item.itemId, quantity, options, addItem: true })} />}
    {checkoutOpen && conversation?.review && <Checkout review={conversation.review} pending={checkoutBusy} error={checkoutError} submissionBlocked={uncertainCarts.includes(conversation.review.cartId)} onClose={() => { if (!checkoutBusy) setCheckoutOpen(false); }} onUpdate={patch => void updateReview(patch)} onConfirm={() => void confirmOrder()} />}
    {addressOpen && <Modal title="Onde a vontade vai chegar?" subtitle="Escolha um endereço salvo ou busque um novo." onClose={() => { if (!addressBusy) setAddressOpen(false); }}><div className="modal-body address-body">{session?.addresses.length ? <div className="saved-addresses">{session.addresses.map(address => <button key={address.id} className={`saved-address ${address.id === session.selectedAddressId ? 'selected' : ''}`} disabled={addressBusy} onClick={() => void saveAddress({ addressId: address.id })}><MapPin size={20} /><span><strong>{address.label}</strong><small>{address.formatted}</small></span>{address.id === session.selectedAddressId ? <CheckCircle2 size={19} /> : <ChevronRight size={18} />}</button>)}</div> : <p className="muted">Nenhum endereço salvo disponível. Encontre seu endereço abaixo.</p>}<form onSubmit={event => { event.preventDefault(); setAddressCandidates([]); void saveAddress({ address: addressText, complement: complement || undefined }); }} className="address-form"><label className="field-label">Endereço completo<input required value={addressText} onChange={event => { setAddressText(event.target.value); setAddressCandidates([]); }} placeholder="Rua, número, bairro e cidade" disabled={addressBusy} autoComplete="street-address" /></label><label className="field-label">Complemento <small>(opcional)</small><input value={complement} onChange={event => setComplement(event.target.value)} placeholder="Apartamento, bloco, referência…" disabled={addressBusy} /></label><button className="button button-primary" type="submit" disabled={addressBusy || addressText.trim().length < 8}>{addressBusy ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}Encontrar endereço</button></form>{addressCandidates.length > 0 && <div className="address-candidates"><h3>Confirme o lugar certo</h3>{addressCandidates.map(candidate => <button className="saved-address" key={candidate.id} disabled={addressBusy} onClick={() => void saveAddress({ address: addressText, complement: complement || undefined, candidateId: candidate.id })}><MapPin size={18} /><span>{candidate.formatted || candidate.label}</span><ChevronRight size={17} /></button>)}</div>}{addressError && <div className="notice notice-error" role="alert">{addressError}</div>}</div></Modal>}
    {receiptOpen && receipt && <Modal title="Sua vontade virou pedido" subtitle={receipt.merchantName} onClose={() => setReceiptOpen(false)}><div className="modal-body receipt-body"><div className="receipt-success"><CheckCircle2 size={39} strokeWidth={1.5} /></div><h3>{receipt.status?.description || 'Pedido criado no iFood'}</h3><p>Acompanhe as atualizações do seu pedido por aqui e na sua conta iFood.</p><dl><div><dt>Pedido</dt><dd>{receipt.id}</dd></div><div><dt>Loja</dt><dd>{receipt.merchantName}</dd></div>{receipt.createdAt && <div><dt>Realizado em</dt><dd>{new Date(receipt.createdAt).toLocaleString('pt-BR')}</dd></div>}<div><dt>Total</dt><dd>{money(receipt.total)}</dd></div></dl>{!receipt.pollingStop && <p className="receipt-updating"><span className="connection-dot" />Buscando atualizações automaticamente</p>}<button className="button button-primary" onClick={() => setReceiptOpen(false)}>Continuar descobrindo<ArrowRight size={17} /></button></div></Modal>}
    {ordersOpen && <Modal title="Suas vontades realizadas" subtitle="Pedidos feitos por aqui." onClose={() => setOrdersOpen(false)}><div className="modal-body order-history">{session?.orders.length ? session.orders.map(order => <button className="history-order" key={order.id} onClick={() => { setOrdersOpen(false); setReceipt(order); setReceiptOpen(true); }}><span className="round-icon"><ShoppingBag size={20} /></span><span><strong>{order.merchantName}</strong><small>{order.status?.description || 'Pedido criado'} · {money(order.total)}</small><time>{new Date(order.createdAt).toLocaleDateString('pt-BR')}</time></span><ChevronRight size={18} /></button>) : <div className="empty-state"><ShoppingBag size={31} /><h3>Sua próxima vontade mora aqui.</h3><p>Seus pedidos vão aparecer depois da primeira descoberta.</p></div>}</div></Modal>}
  </div></div>;
}
