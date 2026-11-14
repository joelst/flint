// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateRetrieval, scoreRetrieval } from './retrieval-quality.mjs';

afterEach(() => vi.unstubAllGlobals());

describe('retrieval quality', () => {
  const corpus = [{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }];
  const queries = [{ id: 'q', text: 'question' }];
  const qrels = [{ queryId: 'q', docId: 'a', score: 1 }];

  it('scores ranked relevance rather than embedding shape alone', () => {
    const best = scoreRetrieval(corpus, queries, qrels, [[1, 0], [0, 1]], [[1, 0]]);
    const worse = scoreRetrieval(corpus, queries, qrels, [[1, 0], [0, 1]], [[0, 1]]);
    expect(best).toMatchObject({ queries: 1, corpus: 2, recallAt10: 1, ndcgAt10: 1 });
    expect(worse.recallAt10).toBe(1);
    expect(worse.ndcgAt10).toBeCloseTo(1 / Math.log2(3));
  });

  it('refuses judgments whose relevant document is missing', () => {
    expect(() => scoreRetrieval(corpus, queries,
      [{ queryId: 'q', docId: 'missing', score: 1 }], [[1], [1]], [[1]]))
      .toThrow(/no complete positive judgments/);
  });

  it('sends a retrieval instruction only for queries and checks every batch', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flint-retrieval-test-')), 'data.json');
    try {
      fs.writeFileSync(file, JSON.stringify({
        corpus: Array.from({ length: 33 }, (_, index) => ({ id: `${index}`, text: `abstract ${index}` })),
        queries, qrels: [{ queryId: 'q', docId: '0', score: 1 }],
      }));
      const inputs = [];
      vi.stubGlobal('fetch', vi.fn(async (_url, request) => {
        const body = JSON.parse(request.body);
        inputs.push(...body.input);
        return { ok: true, json: async () => ({
          data: body.input.map((text, index) => ({
            index, embedding: text === 'abstract 0' || text.startsWith('Instruct: ') ? [1, 0] : [0, 1],
          })),
        }) };
      }));
      const result = await evaluateRetrieval('http://127.0.0.1:1234/v1', 'alias', file);
      expect(inputs).toHaveLength(34);
      expect(inputs[0]).toBe('abstract 0');
      expect(inputs[33]).toMatch(/^Instruct: .* evidence for or against the claim\nQuery: question$/);
      expect(result).toMatchObject({ corpus: 33, queries: 1, dimensions: 2, recallAt10: 1, ndcgAt10: 1 });
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('records source-document truncation at Flint embedding admission, but never truncates queries', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flint-retrieval-test-')), 'data.json');
    try {
      fs.writeFileSync(file, JSON.stringify({
        corpus: [{ id: 'a', text: 'a'.repeat(8193) }],
        queries, qrels,
      }));
      const inputs = [];
      vi.stubGlobal('fetch', vi.fn(async (_url, request) => {
        const body = JSON.parse(request.body);
        inputs.push(...body.input);
        return { ok: true, json: async () => ({
          data: body.input.map((_text, index) => ({ index, embedding: [1, 0] })),
        }) };
      }));
      await expect(evaluateRetrieval('http://127.0.0.1:1234/v1', 'alias', file))
        .resolves.toMatchObject({ truncatedDocuments: 1, recallAt10: 1 });
      expect(inputs[0]).toHaveLength(8192);
      expect(inputs[1]).toContain('\nQuery: question');
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});
