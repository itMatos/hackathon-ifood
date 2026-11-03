import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeImage, decodeImageInput, MAX_IMAGE_BYTES, MAX_READER_OUTPUT_BYTES,
  runVisionReader, validateVisionResult, VisionError,
} from '../server/vision.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l5kAAAAASUVORK5CYII=';
const RESULT = {
  productName: 'Arroz', details: 'Marca e peso não legíveis.',
  searchQueries: ['arroz'], needsClarification: false,
};
const input = { imageBase64: PNG, mimeType: 'image/png' };

function errorCode(code: string) {
  return (error: unknown) => error instanceof VisionError && error.code === code;
}

async function withRunner(source: string, callback: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'viu-pediu-reader-test-'));
  const executable = path.join(directory, 'fake-python.mjs');
  const previousPython = process.env.PYTHON_BIN;
  const previousKey = process.env.GEMINI_API_KEY;
  try {
    await writeFile(executable, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
    process.env.PYTHON_BIN = executable;
    process.env.GEMINI_API_KEY = 'offline-test-key';
    await callback(directory);
  } finally {
    if (previousPython === undefined) delete process.env.PYTHON_BIN;
    else process.env.PYTHON_BIN = previousPython;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
}

test('accepts raw and data URL base64 while checking the declared MIME', () => {
  assert.equal(decodeImageInput(input).toString('base64'), PNG);
  assert.equal(decodeImageInput({ ...input, imageBase64: `data:image/png;base64,${PNG}` }).toString('base64'), PNG);
  assert.throws(() => decodeImageInput({ ...input, mimeType: 'image/jpeg' }), errorCode('IMAGE_INVALID'));
  assert.throws(() => decodeImageInput({ ...input, mimeType: 'image/svg+xml' }), errorCode('IMAGE_UNSUPPORTED'));
  assert.throws(() => decodeImageInput({ ...input, imageBase64: `data:image/jpeg;base64,${PNG}` }), errorCode('IMAGE_INVALID'));
});

test('rejects empty, malformed and noncanonical base64', () => {
  for (const imageBase64 of ['', 'abcd!', 'abc', 'a===', 'abcd\nabcd', 'QR==']) {
    assert.throws(() => decodeImageInput({ ...input, imageBase64 }), VisionError);
  }
});

test('rejects oversized images before decoding and handles the maximum without regex overflow', () => {
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  Buffer.from(PNG, 'base64').copy(bytes);
  assert.throws(() => decodeImageInput({ ...input, imageBase64: bytes.toString('base64') }), errorCode('IMAGE_TOO_LARGE'));
  const maximum = bytes.subarray(0, MAX_IMAGE_BYTES);
  assert.equal(decodeImageInput({ ...input, imageBase64: maximum.toString('base64') }).length, MAX_IMAGE_BYTES);
});

test('validates response shape and treats uncertainty as a request for clarification', () => {
  assert.deepEqual(validateVisionResult(RESULT), RESULT);
  assert.equal(validateVisionResult({ ...RESULT, productName: null }).needsClarification, true);
  assert.equal(validateVisionResult({ ...RESULT, searchQueries: [] }).needsClarification, true);
  for (const result of [null, [], {}, { ...RESULT, searchQueries: ['a', 'b', 'c', 'd'] }, { ...RESULT, needsClarification: 'false' }]) {
    assert.throws(() => validateVisionResult(result), errorCode('VISION_INVALID_RESPONSE'));
  }
});

test('missing Gemini configuration produces an actionable error', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(analyzeImage(input), errorCode('GEMINI_NOT_CONFIGURED'));
  } finally {
    if (previousKey !== undefined) process.env.GEMINI_API_KEY = previousKey;
  }
});

test('subprocess receives separate arguments and temporary photos are removed after success', async () => {
  await withRunner(`
    import fs from 'node:fs';
    import path from 'node:path';
    const photo = process.argv.at(-1);
    fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'arguments.json'), JSON.stringify(process.argv));
    if ((fs.statSync(photo).mode & 0o777) !== 0o600) process.exit(9);
    process.stdout.write(JSON.stringify(${JSON.stringify(RESULT)}));
  `, async directory => {
    assert.deepEqual(await analyzeImage({ ...input, imageName: 'photo; touch injected.png' }), RESULT);
    const args: string[] = JSON.parse(await readFile(path.join(directory, 'arguments.json'), 'utf8'));
    assert.equal(args.at(-4), '--json');
    assert.equal(args.at(-3), '--mime-type');
    assert.equal(args.at(-2), 'image/png');
    const photo = args.at(-1)!;
    await assert.rejects(stat(photo), { code: 'ENOENT' });
    await assert.rejects(stat(path.dirname(photo)), { code: 'ENOENT' });
  });
});

test('temporary photos are removed after a reader error', async () => {
  await withRunner(`
    import fs from 'node:fs';
    import path from 'node:path';
    fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'photo-path'), process.argv.at(-1));
    process.stderr.write(JSON.stringify({error:'Foto inválida.',code:'IMAGE_INVALID'}));
    process.exitCode = 1;
  `, async directory => {
    await assert.rejects(analyzeImage(input), error => errorCode('IMAGE_INVALID')(error) && (error as VisionError).status === 400);
    const photo = await readFile(path.join(directory, 'photo-path'), 'utf8');
    await assert.rejects(stat(path.dirname(photo)), { code: 'ENOENT' });
  });
});

test('invalid or oversized process output cannot become a product', async () => {
  await withRunner("process.stdout.write('not json')", async () => {
    await assert.rejects(runVisionReader('/unused', 'image/png'), errorCode('VISION_INVALID_RESPONSE'));
  });
  await withRunner(`process.stdout.write('x'.repeat(${MAX_READER_OUTPUT_BYTES + 1}))`, async () => {
    await assert.rejects(runVisionReader('/unused', 'image/png'), errorCode('VISION_OUTPUT_TOO_LARGE'));
  });
});

test('reader timeout terminates the child and returns an explicit failure', async () => {
  await withRunner('setInterval(() => {}, 1000)', async () => {
    await assert.rejects(runVisionReader('/unused', 'image/png', 100), error =>
      errorCode('VISION_TIMEOUT')(error) && (error as VisionError).status === 504);
  });
});

test('missing Python executable returns configuration error', async () => {
  await withRunner('', async directory => {
    process.env.PYTHON_BIN = path.join(directory, 'missing-python');
    await assert.rejects(runVisionReader('/unused', 'image/png'), errorCode('VISION_PROCESS_UNAVAILABLE'));
  });
});

test('unstructured stderr does not expose provider secrets', async () => {
  await withRunner("process.stderr.write('api_key=secret-do-not-expose'); process.exitCode = 1", async () => {
    await assert.rejects(runVisionReader('/unused', 'image/png'), error =>
      errorCode('VISION_PROCESS_FAILED')(error) && !(error as Error).message.includes('secret-do-not-expose'));
  });
});
