import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Conversation, ItemDetails, OrderReceipt } from '../shared/types.ts';
import type { StoredOfferQuote } from './curation.ts';
import { AppError } from './errors.ts';

export interface ConversationRecord extends Conversation {
  history: any[];
  itemCache: Record<string, ItemDetails>;
  reviewSnapshot?: string;
  cartAddressSnapshot?: string;
  cartDeliverySnapshot?: string;
  offerQuotes?: Record<string, StoredOfferQuote>;
}
export interface Attempt { state: 'submitting' | 'unknown' | 'done'; receipt?: OrderReceipt; }

export class Store {
  private db: DatabaseSync;
  constructor(filename = process.env.DATABASE_PATH || path.resolve('data/viu-pediu.sqlite')) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS conversations_owner ON conversations(owner, updated_at);
      CREATE TABLE IF NOT EXISTS attempts (owner TEXT NOT NULL, cart_id TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT, PRIMARY KEY(owner,cart_id));
      CREATE UNIQUE INDEX IF NOT EXISTS attempts_cart_global ON attempts(cart_id);
      CREATE TABLE IF NOT EXISTS orders (id TEXT NOT NULL, owner TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner,id));`);
    // A process may have stopped after sending the request. Never replay that request.
    this.db.exec("UPDATE attempts SET state='unknown' WHERE state='submitting'");
  }
  createConversation(owner: string): ConversationRecord {
    const record = { id: randomUUID(), messages: [], offers: [], history: [], itemCache: {} };
    this.saveConversation(owner, record);
    return record;
  }
  conversation(owner: string, id?: string): ConversationRecord {
    const row = id
      ? this.db.prepare('SELECT body FROM conversations WHERE owner=? AND id=?').get(owner, id)
      : this.db.prepare('SELECT body FROM conversations WHERE owner=? ORDER BY updated_at DESC LIMIT 1').get(owner);
    if (!row) {
      if (id) throw new AppError('Esta conversa não foi encontrada. Inicie uma nova conversa.', 404, 'CONVERSATION_NOT_FOUND');
      return this.createConversation(owner);
    }
    return JSON.parse(String(row.body));
  }
  saveConversation(owner: string, record: ConversationRecord) {
    this.db.prepare('INSERT INTO conversations(id,owner,body,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at WHERE owner=excluded.owner')
      .run(record.id, owner, JSON.stringify(record), Date.now());
  }
  attempt(owner: string, cartId: string): Attempt | undefined {
    const row = this.db.prepare('SELECT state,receipt FROM attempts WHERE owner=? AND cart_id=?').get(owner, cartId);
    return row ? { state: row.state as Attempt['state'], receipt: row.receipt ? JSON.parse(String(row.receipt)) : undefined } : undefined;
  }
  beginAttempt(owner: string, cartId: string): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO attempts(owner,cart_id,state) VALUES(?,?,'submitting')").run(owner, cartId).changes === 1;
  }
  unknownAttempt(owner: string, cartId: string) {
    this.db.prepare("UPDATE attempts SET state='unknown' WHERE owner=? AND cart_id=? AND state!='done'").run(owner, cartId);
  }
  completeAttempt(owner: string, cartId: string, receipt: OrderReceipt) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE attempts SET state='done',receipt=? WHERE owner=? AND cart_id=?").run(JSON.stringify(receipt), owner, cartId);
      this.saveOrder(owner, receipt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveOrder(owner: string, receipt: OrderReceipt) {
    this.db.prepare('INSERT INTO orders(id,owner,body,created_at) VALUES(?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET body=excluded.body')
      .run(receipt.id, owner, JSON.stringify(receipt), Date.now());
  }
  orders(owner: string): OrderReceipt[] {
    return this.db.prepare('SELECT body FROM orders WHERE owner=? ORDER BY created_at DESC LIMIT 50').all(owner).map(row => JSON.parse(String(row.body)));
  }
  order(owner: string, id: string): OrderReceipt {
    const row = this.db.prepare('SELECT body FROM orders WHERE owner=? AND id=?').get(owner, id);
    if (!row) throw new AppError('Pedido não encontrado nesta conta.', 404, 'ORDER_NOT_FOUND');
    return JSON.parse(String(row.body));
  }
  close() { this.db.close(); }
}

export function publicConversation(record: ConversationRecord): Conversation {
  const { history, itemCache, reviewSnapshot, cartAddressSnapshot, cartDeliverySnapshot, offerQuotes, ...conversation } = record;
  return conversation;
}

export class SerialLocks {
  private held = new Set<string>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.held.has(key)) throw new AppError('Uma operação já está em andamento. Aguarde um instante.', 409, 'BUSY');
    this.held.add(key);
    try { return await fn(); } finally { this.held.delete(key); }
  }
}
