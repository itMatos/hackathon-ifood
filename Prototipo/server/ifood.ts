import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Ajv, { type ValidateFunction } from 'ajv';
import type { Address, ItemDetails, MerchantType, Offer } from '../shared/types';
import type { AuthManager, AuthSession } from './auth';

export interface ToolDefinition { name: string; description?: string; inputSchema: Record<string, any> }
export interface ToolGateway {
  listTools(): Promise<ToolDefinition[]>;
  call(name: string, args: Record<string, unknown>): Promise<any>;
}

export const DOCUMENTED_TOOLS = new Set([
  'getUser', 'listAddresses', 'createAddress', 'searchOffers', 'browseOffers', 'getRecommendations', 'listItemTaxonomy', 'getMerchant', 'getItem',
  'createCart', 'getCart', 'getCartDeliveryMethods', 'addItemToCart', 'updateCartItem', 'removeItemFromCart', 'removeVoucher', 'listVouchers',
  'setVoucher', 'setCartDelivery', 'listPaymentMethods', 'setCartPayment', 'submitOrder', 'trackOrder', 'getOrder',
]);

export class IfoodError extends Error {
  constructor(message: string, public code = 'IFOOD_ERROR', public status = 502, public details?: unknown) { super(message); this.name = 'IfoodError'; }
}

/** Decode MCP envelopes once; callers work with the provider's domain response. */
export function unwrapToolResult(result: any): any {
  let payload = result?.structuredContent;
  if (payload === undefined && Array.isArray(result?.content)) {
    const texts = result.content.filter((part: any) => part.type === 'text' && typeof part.text === 'string');
    if (texts.length === 1) { try { payload = JSON.parse(texts[0].text); } catch { payload = { message: texts[0].text }; } }
    else if (texts.length > 1) {
      const parsed = texts.map((part: any) => { try { return JSON.parse(part.text); } catch { return { message: part.text }; } });
      if (parsed.length === 1) payload = parsed[0];
      else payload = { results: parsed };
    }
  }
  if (payload === undefined) payload = result;
  function meaningful(value: any): boolean {
    return value !== null && value !== undefined && value !== false && (Array.isArray(value) ? value.length > 0 : typeof value === 'object' ? Object.keys(value).length > 0 : Boolean(value));
  }
  let failure: any;
  let nested = payload;
  for (let depth = 0; depth < 8 && nested && typeof nested === 'object'; depth++) {
    if (meaningful(nested.error)) { failure = nested.error; break; }
    if (meaningful(nested.errors)) { failure = nested.errors; break; }
    if (nested.errorType || nested.success === false) { failure = nested; break; }
    nested = nested.response ?? nested.data;
  }
  if (result?.isError || failure) {
    const error = Array.isArray(failure) ? failure[0] : failure || payload;
    const code = typeof error?.code === 'string' ? error.code : 'IFOOD_TOOL_ERROR';
    const message = error?.userFriendlyMessage || error?.message || 'O iFood não conseguiu concluir esta operação.';
    throw new IfoodError(String(message).slice(0, 1200), code, /AUTH|TOKEN|ACCESS_DENIED/.test(code) ? 401 : 422, error);
  }
  while (payload?.response && typeof payload.response === 'object' && !Array.isArray(payload.response)) payload = payload.response;
  return payload;
}

export class IfoodGateway implements ToolGateway {
  private client?: Client;
  private token?: string;
  private connecting?: Promise<Client>;
  private listing?: Promise<ToolDefinition[]>;
  private definitions?: ToolDefinition[];
  private validators = new Map<string, ValidateFunction>();
  private ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  constructor(private auth: AuthManager, private session: AuthSession) {}

  private authenticationFailure(error: any): any {
    if (error?.status === 401 || error?.code === 401) {
      this.session.tokens = undefined;
      this.session.capabilities = [];
      this.session.addresses = [];
      this.session.selectedAddressId = undefined;
      this.definitions = undefined;
      return new IfoodError('Sua autorização iFood expirou ou foi revogada. Conecte novamente.', 'AUTH_REQUIRED', 401);
    }
    return error;
  }

  private async connection(): Promise<Client> {
    const token = await this.auth.accessToken(this.session);
    if (this.client && this.token === token) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (this.client) await this.client.close().catch(() => undefined);
      const endpoint = new URL(process.env.IFOOD_MCP_URL || 'https://consumer-mcp.ifood.com.br/marketplace');
      if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(endpoint.hostname)) throw new IfoodError('O servidor MCP deve usar HTTPS.', 'MCP_CONFIGURATION_ERROR', 503);
      const client = new Client({ name: 'viu-pediu', version: '1.0.0' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
      try { await client.connect(transport, { timeout: 20_000 }); }
      catch (error: any) { await client.close().catch(() => undefined); const failure = this.authenticationFailure(error); if (failure?.status === 401) throw failure; throw new IfoodError('Não foi possível conectar ao MCP iFood. Confira a autorização do agente.', 'MCP_CONNECTION_FAILED'); }
      this.client = client;
      this.token = token;
      this.definitions = undefined;
      this.validators.clear();
      this.ajv.removeSchema();
      return client;
    })();
    try { return await this.connecting; } finally { this.connecting = undefined; }
  }

  async listTools(): Promise<ToolDefinition[]> {
    const client = await this.connection();
    if (this.definitions) return this.definitions;
    if (this.listing) return this.listing;
    this.listing = this.discoverTools(client);
    try { return await this.listing; } catch (error) { throw this.authenticationFailure(error); } finally { this.listing = undefined; }
  }

  private async discoverTools(client: Client): Promise<ToolDefinition[]> {
    const definitions: ToolDefinition[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 20_000 });
      for (const tool of page.tools) {
        if (!DOCUMENTED_TOOLS.has(tool.name)) continue;
        const definition = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Record<string, any> };
        try { this.validators.set(tool.name, this.ajv.compile(definition.inputSchema)); }
        catch { throw new IfoodError(`Schema incompatível na ferramenta ${tool.name}.`, 'MCP_SCHEMA_UNSUPPORTED'); }
        definitions.push(definition);
      }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new IfoodError('Paginação inválida do catálogo de ferramentas.', 'MCP_INVALID_RESPONSE');
      if (cursor) seen.add(cursor);
      if (seen.size > 32) throw new IfoodError('Catálogo de ferramentas excedeu o limite de paginação.', 'MCP_INVALID_RESPONSE');
    } while (cursor);
    this.definitions = definitions;
    this.session.capabilities = definitions.map(tool => tool.name);
    return definitions;
  }

  async call(name: string, args: Record<string, unknown>): Promise<any> {
    if (!DOCUMENTED_TOOLS.has(name)) throw new IfoodError('Ferramenta iFood não autorizada.', 'TOOL_NOT_ALLOWED', 403);
    await this.listTools();
    const validator = this.validators.get(name);
    if (!validator) throw new IfoodError(`O agente iFood não disponibiliza ${name}.`, 'TOOL_UNAVAILABLE', 422);
    if (!validator(args)) throw new IfoodError(`Parâmetros inválidos para ${name}.`, 'TOOL_ARGUMENTS_INVALID', 400, validator.errors);
    const client = await this.connection();
    try {
      // Mutations are deliberately never retried: a timeout may follow a successful write.
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
      return unwrapToolResult(result);
    } catch (error) {
      const failure = this.authenticationFailure(error);
      if (failure instanceof IfoodError) throw failure;
      throw new IfoodError(`Não foi possível concluir ${name} no iFood.`, 'MCP_REQUEST_FAILED');
    }
  }

  async close(): Promise<void> { await this.client?.close(); this.client = undefined; }
}

function object(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}; }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function rows(raw: any, keys: string[]): any[] {
  if (Array.isArray(raw)) return raw;
  for (const key of keys) if (Array.isArray(raw?.[key])) return raw[key];
  if (raw?.response && raw.response !== raw) return rows(raw.response, keys);
  if (raw?.data && raw.data !== raw) return rows(raw.data, keys);
  return [];
}
function body(raw: any): Record<string, any> {
  let value = raw;
  for (let depth = 0; depth < 8 && value && typeof value === 'object'; depth++) {
    if (value.response && typeof value.response === 'object') value = value.response;
    else if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) value = value.data;
    else break;
  }
  return object(value);
}
function price(raw: any): number | undefined {
  const value = number(raw.promotionalUnitPrice) ?? number(raw.unitPrice) ?? number(raw.price);
  return value !== undefined && value >= 0 ? value : undefined;
}

export function normalizeAddresses(raw: any): Address[] {
  return rows(raw, ['results', 'addresses']).flatMap(entry => {
    const item = object(entry);
    const coordinates = object(item.coordinates ?? item.userLocation ?? item.location);
    const id = string(item.addressId ?? item.id);
    const latitude = number(coordinates.latitude);
    const longitude = number(coordinates.longitude);
    const formatted = string(item.formattedAddress ?? item.formatted);
    if (!id || !formatted || latitude === undefined || longitude === undefined || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return [];
    return [{ id, formatted, label: string(item.alias ?? item.label) || formatted, latitude, longitude }];
  });
}

export function normalizeOffers(raw: any): Offer[] {
  const envelope = body(raw);
  return rows(raw, ['results', 'offers']).flatMap(entry => {
    const item = object(entry);
    const merchant = object(item.merchant);
    const merchantId = string(item.merchantId ?? merchant.merchantId);
    const merchantName = string(item.merchantName ?? merchant.merchantName);
    const itemId = string(item.itemId);
    const name = string(item.itemName ?? item.name) || merchantName;
    if (!merchantId || !merchantName || !name) return [];
    const delivery = object(item.deliveryMethod ?? merchant.deliveryMethod);
    const estimate = object(delivery.estimatedMinutes);
    const minimum = number(item.minimumOrderAmount ?? item.orderMinimumPrice ?? merchant.minimumOrderAmount);
    const min = number(estimate.min); const max = number(estimate.max);
    return [{
      id: `${merchantId}:${itemId || 'merchant'}`, merchantId, itemId, merchantName, name,
      description: string(item.itemDescription ?? item.description), imageUrl: string(item.itemImageUrl ?? item.merchantLogoUrl),
      price: price(item), deliveryFee: number(delivery.promotionalFee) ?? number(delivery.fee),
      deliveryMinutes: max ?? min, deliveryLabel: min !== undefined && max !== undefined ? `${min}–${max} min` : undefined,
      minimumOrder: minimum, merchantType: string(item.merchantType ?? envelope.merchantType) as MerchantType | undefined,
    }];
  });
}

export function normalizeItems(raw: any, merchantId: string): ItemDetails[] {
  const envelope = body(raw);
  const entries = envelope.itemId ? [envelope] : rows(envelope, ['featuredItems', 'items', 'results']);
  return entries.flatMap(entry => {
    const item = object(entry);
    const itemId = string(item.itemId);
    const name = string(item.itemName ?? item.name);
    const actualMerchantId = string(item.merchantId ?? envelope.merchantId) || merchantId;
    if (!itemId || !name || !actualMerchantId) return [];
    if (item.optionGroups !== undefined && !Array.isArray(item.optionGroups)) throw new IfoodError('O iFood retornou complementos inválidos para este item.', 'INVALID_ITEM_OPTIONS');
    const groups = Array.isArray(item.optionGroups) ? item.optionGroups : [];
    return [{ merchantId: actualMerchantId, itemId, name, description: string(item.itemDescription ?? item.description), price: price(item), imageUrl: string(item.itemImageUrl),
      optionGroups: groups.flatMap((group: any) => {
        const id = string(group.optionGroupId ?? group.id); const label = string(group.name);
        if (!id || !label || !Number.isInteger(group.minSelections) || !Number.isInteger(group.maxSelections) || group.minSelections < 0 || group.maxSelections < group.minSelections || !Array.isArray(group.options)) {
          throw new IfoodError('O iFood não informou as regras completas dos complementos. Consulte o item novamente.', 'INVALID_ITEM_OPTIONS');
        }
        return [{ id, name: label, min: group.minSelections, max: group.maxSelections,
          options: (Array.isArray(group.options) ? group.options : []).flatMap((option: any) => {
            const optionId = string(option.optionId ?? option.id); const optionName = string(option.name);
            return optionId && optionName ? [{ id: optionId, name: optionName, price: number(option.additionalPrice) }] : [];
          }),
        }];
      }),
    }];
  });
}
