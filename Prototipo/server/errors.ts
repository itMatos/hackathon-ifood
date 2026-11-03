export class AppError extends Error {
  constructor(message: string, public status = 400, public code = 'INVALID_REQUEST', public extra?: Record<string, unknown>) { super(message); }
}
export function assert(condition: unknown, message: string, status = 400, code = 'INVALID_REQUEST', extra?: Record<string, unknown>): asserts condition {
  if (!condition) throw new AppError(message, status, code, extra);
}
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível concluir esta operação.';
}
