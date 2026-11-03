import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VisionResult } from '../shared/types.ts';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const VISION_TIMEOUT_MS = 45_000;
export const MAX_READER_OUTPUT_BYTES = 64 * 1024;
const SUPPORTED_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const readerScript = path.join(repositoryRoot, 'APIgemini.py');

export class VisionError extends Error {
  constructor(message: string, public status = 502, public code = 'VISION_FAILED') {
    super(message);
    this.name = 'VisionError';
  }
}

export interface ImageInput {
  imageBase64: string;
  mimeType: string;
  imageName?: string;
}

export function decodeImageInput(input: ImageInput): Buffer {
  if (!input || !SUPPORTED_MIMES.includes(input.mimeType as typeof SUPPORTED_MIMES[number])) {
    throw new VisionError('Envie uma foto JPEG, PNG ou WebP.', 415, 'IMAGE_UNSUPPORTED');
  }
  if (typeof input.imageBase64 !== 'string' || !input.imageBase64) {
    throw new VisionError('Envie uma foto para identificar o produto.', 400, 'IMAGE_REQUIRED');
  }
  let base64 = input.imageBase64;
  if (base64.startsWith('data:')) {
    const comma = base64.indexOf(',');
    if (comma < 0 || base64.slice(0, comma) !== `data:${input.mimeType};base64`) {
      throw new VisionError('O formato informado não corresponde à foto.', 400, 'IMAGE_INVALID');
    }
    base64 = base64.slice(comma + 1);
  }
  if (base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw new VisionError('Envie uma foto com até 10 MiB.', 413, 'IMAGE_TOO_LARGE');
  }
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new VisionError('Os dados da foto são inválidos.', 400, 'IMAGE_INVALID');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.toString('base64') !== base64) {
    throw new VisionError('Os dados da foto são inválidos.', 400, 'IMAGE_INVALID');
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new VisionError('Envie uma foto com até 10 MiB.', 413, 'IMAGE_TOO_LARGE');
  }
  const isJpeg = bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const isPng = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isWebp = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  const detected = isJpeg ? 'image/jpeg' : isPng ? 'image/png' : isWebp ? 'image/webp' : undefined;
  if (detected !== input.mimeType) {
    throw new VisionError('O conteúdo da foto não corresponde ao formato informado.', 400, 'IMAGE_INVALID');
  }
  return bytes;
}

export function validateVisionResult(value: unknown): VisionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VisionError('O leitor retornou uma identificação inválida.', 502, 'VISION_INVALID_RESPONSE');
  }
  const result = value as Record<string, unknown>;
  if ((result.productName !== null && (typeof result.productName !== 'string' || !result.productName.trim() || result.productName.length > 300)) ||
    typeof result.details !== 'string' || result.details.length > 2000 ||
    !Array.isArray(result.searchQueries) || result.searchQueries.length > 3 ||
    result.searchQueries.some(query => typeof query !== 'string' || !query.trim() || query.length > 200) ||
    typeof result.needsClarification !== 'boolean') {
    throw new VisionError('O leitor retornou uma identificação inválida.', 502, 'VISION_INVALID_RESPONSE');
  }
  return {
    productName: result.productName === null ? null : (result.productName as string).trim(),
    details: result.details.trim(),
    searchQueries: result.searchQueries.map((query: string) => query.trim()),
    needsClarification: result.needsClarification || result.productName === null || result.searchQueries.length === 0,
  };
}

function pythonError(stderr: string): VisionError {
  try {
    const result = JSON.parse(stderr.trim());
    if (typeof result.code === 'string' && typeof result.error === 'string') {
      const statuses: Record<string, number> = {
        IMAGE_INVALID: 400, IMAGE_NOT_FOUND: 400, IMAGE_TOO_LARGE: 413,
        IMAGE_UNSUPPORTED: 415, GEMINI_NOT_CONFIGURED: 503, VISION_DEPENDENCIES_MISSING: 503,
      };
      const knownCodes = new Set([...Object.keys(statuses), 'VISION_EMPTY_RESPONSE', 'VISION_INVALID_RESPONSE', 'GEMINI_REQUEST_FAILED']);
      if (knownCodes.has(result.code)) return new VisionError(result.error, statuses[result.code] ?? 502, result.code);
    }
  } catch { /* Expose only the reader's documented JSON errors. */ }
  return new VisionError('Não foi possível analisar a foto. Confira as dependências Python e a configuração do Gemini.', 502, 'VISION_PROCESS_FAILED');
}

// Exported to test process failures and timeouts without calling Gemini.
export function runVisionReader(imagePath: string, mimeType: string, timeoutMs = VISION_TIMEOUT_MS): Promise<VisionResult> {
  const configuredPython = process.env.PYTHON_BIN || 'python3';
  const executable = configuredPython.includes('/') || configuredPython.includes('\\')
    ? path.resolve(process.cwd(), configuredPython) : configuredPython;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [readerScript, '--json', '--mime-type', mimeType, imagePath], {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let failure: VisionError | undefined;
    const timer = setTimeout(() => {
      failure = new VisionError('A análise demorou demais. Tente novamente ou envie outra foto.', 504, 'VISION_TIMEOUT');
      child.kill('SIGKILL');
    }, timeoutMs);
    const settle = (error?: VisionError, value?: VisionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const capture = (chunks: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_READER_OUTPUT_BYTES) {
        failure ??= new VisionError('O leitor retornou uma resposta muito grande.', 502, 'VISION_OUTPUT_TOO_LARGE');
        child.kill('SIGKILL');
      } else chunks.push(chunk);
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.on('error', () => settle(new VisionError('Não foi possível iniciar o leitor. Confira PYTHON_BIN e as dependências Python.', 503, 'VISION_PROCESS_UNAVAILABLE')));
    child.on('close', code => {
      if (failure) return settle(failure);
      if (code !== 0) return settle(pythonError(Buffer.concat(stderr).toString('utf8')));
      try {
        settle(undefined, validateVisionResult(JSON.parse(Buffer.concat(stdout).toString('utf8'))));
      } catch (error) {
        settle(error instanceof VisionError ? error : new VisionError('O leitor retornou uma identificação inválida.', 502, 'VISION_INVALID_RESPONSE'));
      }
    });
  });
}

export async function analyzeImage(input: ImageInput): Promise<VisionResult> {
  const bytes = decodeImageInput(input);
  if (!process.env.GEMINI_API_KEY) {
    throw new VisionError('Configure GEMINI_API_KEY para identificar fotos.', 503, 'GEMINI_NOT_CONFIGURED');
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'viu-pediu-vision-'));
  try {
    const extension = input.mimeType === 'image/jpeg' ? 'jpg' : input.mimeType === 'image/png' ? 'png' : 'webp';
    const imagePath = path.join(directory, `photo.${extension}`);
    await writeFile(imagePath, bytes, { mode: 0o600 });
    return await runVisionReader(imagePath, input.mimeType);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
