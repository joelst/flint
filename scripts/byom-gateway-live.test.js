// @vitest-environment node
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  catalogCacheTarget, parseArgs, stopSidecar, validateBase64Embeddings, validateEmbeddings,
} from './byom-gateway-live.mjs';

afterEach(() => vi.useRealTimers());

function sidecarFixture() {
  let close;
  const sidecar = {
    hasClosed: false,
    exited: new Promise((resolve) => { close = resolve; }),
    send: vi.fn(async () => ({ ok: true, result: { cleanup: 'confirmed' } })),
    child: { kill: vi.fn() },
  };
  return {
    sidecar,
    close: () => { sidecar.hasClosed = true; close({ code: null, signal: 'SIGTERM' }); },
  };
}

describe('BYOM runner cleanup', () => {
  it('does not claim graceful cleanup when the sidecar already closed', async () => {
    const { sidecar } = sidecarFixture();
    sidecar.hasClosed = true;
    await expect(stopSidecar(sidecar)).resolves.toMatchObject({
      error: expect.stringMatching(/closed before.*shutdown/),
      forced: false,
    });
    expect(sidecar.send).not.toHaveBeenCalled();
  });

  it('waits for child close after the shutdown acknowledgement instead of killing immediately', async () => {
    vi.useFakeTimers();
    const { sidecar, close } = sidecarFixture();
    const stopping = stopSidecar(sidecar);
    setTimeout(close, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(stopping).resolves.toEqual({ error: null, forced: false });
    expect(sidecar.child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recognizes signal termination only after close, even with no numeric exit code', async () => {
    vi.useFakeTimers();
    const { sidecar, close } = sidecarFixture();
    sidecar.child.kill.mockImplementation(() => { setTimeout(close, 10); return true; });
    const stopping = stopSidecar(sidecar, { graceMs: 20 });
    await vi.advanceTimersByTimeAsync(30);
    await expect(stopping).resolves.toMatchObject({
      error: expect.stringMatching(/forced termination/),
      forced: true,
    });
    expect(sidecar.child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the work directory when forced termination cannot be confirmed', async () => {
    vi.useFakeTimers();
    const { sidecar } = sidecarFixture();
    const stopping = stopSidecar(sidecar, { graceMs: 10, forceMs: 20 });
    await vi.advanceTimersByTimeAsync(30);
    await expect(stopping).resolves.toMatchObject({
      error: expect.stringMatching(/did not close.*retained/),
      forced: true,
    });
    expect(sidecar.hasClosed).toBe(false);
  });

  it('keeps a rejected shutdown outcome even after the child closes', async () => {
    const { sidecar, close } = sidecarFixture();
    sidecar.send.mockImplementation(async () => { close(); return { ok: false, error: 'drain failed' }; });
    await expect(stopSidecar(sidecar)).resolves.toMatchObject({
      error: expect.stringMatching(/drain failed/),
      forced: false,
    });
  });

  it.each(['failed', 'timed-out'])('reports %s runtime cleanup even after a graceful child close', async (cleanup) => {
    const { sidecar, close } = sidecarFixture();
    sidecar.send.mockImplementation(async () => {
      close();
      return { ok: true, result: { cleanup, unloadFailures: ['flint-byom-live'] } };
    });
    await expect(stopSidecar(sidecar)).resolves.toMatchObject({
      error: expect.stringMatching(new RegExp(`cleanup.*${cleanup}`)),
      forced: false,
    });
  });
});

describe('BYOM runner copy selection', () => {
  it('requires an explicit copy option and rejects missing model values', () => {
    expect(parseArgs(['--model', 'model']).copy).toBe(false);
    expect(parseArgs(['--copy', '--model', 'model']).copy).toBe(true);
    expect(() => parseArgs(['--model'])).toThrow(/requires a folder/);
    expect(() => parseArgs(['--model', '--copy'])).toThrow(/requires a folder/);
  });

  it('accepts a restart qualification mode without changing copy selection', () => {
    expect(parseArgs(['--restart', '--model', 'model'])).toMatchObject({
      restart: true,
      copy: false,
    });
  });

  it('accepts an embedding qualification mode', () => {
    expect(parseArgs(['--embeddings', '--model', 'model'])).toMatchObject({
      embeddings: true,
      copy: false,
    });
  });

  it('accepts a source-pinned retrieval dataset for an embedding run', () => {
    expect(parseArgs(['--embeddings', '--model', 'model', '--retrieval', 'dataset.json']))
      .toMatchObject({ embeddings: true, retrieval: 'dataset.json' });
    expect(() => parseArgs(['--retrieval'])).toThrow(/requires a JSON dataset path/);
    expect(() => parseArgs(['--model', 'model', '--retrieval', 'dataset.json']))
      .toThrow(/requires --embeddings/);
  });

  it('accepts an isolated cached catalog retrieval without treating the source as an import', () => {
    expect(parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'qwen3-embedding-0.6b',
      '--catalog-variant', 'qwen3-embedding-0.6b-cuda-gpu:1',
      '--embeddings', '--retrieval', 'dataset.json',
    ])).toMatchObject({
      catalogAlias: 'qwen3-embedding-0.6b',
      catalogVariant: 'qwen3-embedding-0.6b-cuda-gpu:1',
      copy: false,
      restart: false,
    });
    expect(() => parseArgs(['--model', 'catalog/v1', '--catalog-alias', 'a', '--embeddings']))
      .toThrow(/catalog-variant/);
    expect(() => parseArgs(['--model', 'catalog/v1', '--catalog-variant', 'v:1', '--embeddings']))
      .toThrow(/catalog-alias/);
    expect(() => parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1', '--copy',
      '--embeddings',
    ])).toThrow(/cannot.*copy/i);
    expect(parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1',
      '--preflight',
    ])).toMatchObject({ catalogAlias: 'a', preflight: true, embeddings: false });
    expect(() => parseArgs(['--model', 'model', '--embeddings', '--preflight']))
      .toThrow(/requires a chat model/);
    expect(parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1',
      '--admission-errors',
    ])).toMatchObject({ admissionErrors: true, embeddings: false });
    expect(() => parseArgs(['--model', 'model', '--admission-errors']))
      .toThrow(/requires a cached catalog chat model/);
    expect(parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1', '--concurrent',
    ])).toMatchObject({ concurrent: true, embeddings: false });
    expect(() => parseArgs(['--model', 'model', '--concurrent']))
      .toThrow(/requires a cached catalog chat model/);
    expect(parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1', '--cancel-stream',
    ])).toMatchObject({ cancelStream: true, embeddings: false });
    expect(() => parseArgs(['--model', 'model', '--cancel-stream']))
      .toThrow(/requires a cached catalog chat model/);
    expect(() => parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1',
      '--embeddings', '--cancel-stream',
    ])).toThrow(/requires a cached catalog chat model/);
    expect(parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1', '--idle-eviction',
    ])).toMatchObject({ idleEviction: true, embeddings: false });
    expect(() => parseArgs(['--model', 'model', '--idle-eviction']))
      .toThrow(/requires a cached catalog chat model/);
    expect(() => parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1',
      '--embeddings', '--idle-eviction',
    ])).toThrow(/requires a cached catalog chat model/);
    expect(parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1', '--require-tools',
    ])).toMatchObject({ requireTools: true });
    expect(() => parseArgs(['--model', 'model', '--require-tools']))
      .toThrow(/requires a cached catalog chat model/);
    expect(parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1', '--probe-responses',
    ])).toMatchObject({ probeResponses: true });
    expect(() => parseArgs(['--model', 'model', '--probe-responses']))
      .toThrow(/requires a cached catalog chat model/);
    expect(parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1', '--disconnect-only',
    ])).toMatchObject({ disconnectOnly: true });
    expect(() => parseArgs(['--model', 'model', '--disconnect-only']))
      .toThrow(/requires a cached catalog chat model/);
    expect(parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1',
      '--active-eviction', '--coexist-model', 'other/v2', '--coexist-alias', 'b',
      '--coexist-variant', 'w:2',
    ])).toMatchObject({
      activeEviction: true, coexistModel: path.resolve('other/v2'),
      coexistAlias: 'b', coexistVariant: 'w:2',
    });
    expect(() => parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1',
      '--active-eviction', '--coexist-model', 'other/v2', '--coexist-alias', 'a',
      '--coexist-variant', 'w:2',
    ])).toThrow(/distinct --coexist-model/);
    expect(() => parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1',
      '--probe-responses', '--disconnect-only',
    ])).toThrow(/without tool or disconnect probes/);
    expect(parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1',
      '--packaged-root', 'target/release',
    ])).toMatchObject({ packagedRoot: path.resolve('target/release') });
    expect(() => parseArgs(['--model', 'model', '--packaged-root']))
      .toThrow(/requires a release resource directory/);
    expect(parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1',
      '--switch-model', 'catalog/v2', '--switch-variant', 'v:2',
    ])).toMatchObject({
      catalogAlias: 'a', switchModel: path.resolve('catalog/v2'), switchVariant: 'v:2',
    });
    expect(() => parseArgs([
      '--model', 'catalog/v1', '--catalog-alias', 'a', '--catalog-variant', 'v:1',
      '--switch-model', 'catalog/v1', '--switch-variant', 'v:1',
    ])).toThrow(/different versioned model id/);
  });
});

describe('gateway embedding parity', () => {
  it('accepts float32 little-endian base64 vectors matching float responses', () => {
    const bytes = Buffer.alloc(8);
    bytes.writeFloatLE(0.1, 0);
    bytes.writeFloatLE(-2.5, 4);
    expect(() => validateBase64Embeddings(
      { data: [{ embedding: bytes.toString('base64') }] }, [[0.1, -2.5]],
    )).not.toThrow();
    expect(() => validateBase64Embeddings(
      { data: [{ embedding: bytes.toString('base64') }] }, [[0.2, -2.5]],
    )).toThrow(/differs/);
    expect(() => validateBase64Embeddings(
      { data: [{ embedding: 'AAAA' }] }, [[0.1, -2.5]],
    )).toThrow(/invalid float32 payload/);
  });
});

describe('isolated catalog cache', () => {
  it('copies only the selected variant into the temporary catalog cache layout', () => {
    const home = path.resolve('scratch');
    const variant = 'qwen3-embedding-0.6b-cuda-gpu-1';
    const model = path.join('source', 'Microsoft', variant, 'v1');
    expect(catalogCacheTarget(model, 'qwen3-embedding-0.6b-cuda-gpu:1', home, 'flint-live'))
      .toBe(path.join(home, '.flint-live', 'cache', 'models', 'Microsoft', variant, 'v1'));
    expect(() => catalogCacheTarget(path.join('source', 'Microsoft', 'qwen3-embedding-0.6b-cuda-gpu-2', 'v1'),
      'qwen3-embedding-0.6b-cuda-gpu:1', home, 'flint-live'))
      .toThrow(/does not match/);
    expect(() => catalogCacheTarget(path.join('source', 'Microsoft', variant, 'v2'),
      'qwen3-embedding-0.6b-cuda-gpu:1', home, 'flint-live'))
      .toThrow(/does not match/);
  });
});

describe('BYOM embedding qualification', () => {
  it('accepts two finite, nonzero vectors of matching dimensions', () => {
    expect(validateEmbeddings({
      data: [{ embedding: [1, 0] }, { embedding: [0, 1] }],
    })).toEqual([[1, 0], [0, 1]]);
  });

  it.each([
    { data: {} },
    { data: [{ embedding: [1, 0] }] },
    { data: [{ embedding: [1, 0] }, { embedding: [0] }] },
    { data: [{ embedding: [1, 0] }, { embedding: [NaN, 0] }] },
    { data: [{ embedding: [1, 0] }, { embedding: [0, 0] }] },
  ])('refuses incomplete or invalid vectors: %j', (response) => {
    expect(() => validateEmbeddings(response)).toThrow(/embedding/i);
  });
});
