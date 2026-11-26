import fs from 'node:fs';

function readRetrievalDataset(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.corpus) || !Array.isArray(data.queries) ||
    !Array.isArray(data.qrels) || !data.corpus.length || !data.queries.length ||
    !data.qrels.length) {
    throw new Error('Retrieval data requires nonempty corpus, queries, and qrels arrays.');
  }
  for (const [name, rows] of [['corpus', data.corpus], ['queries', data.queries]]) {
    if (rows.some((row) => typeof row?.id !== 'string' || !row.id ||
      typeof row.text !== 'string' || !row.text.trim())) {
      throw new Error(`Retrieval ${name} rows require a nonempty id and text.`);
    }
    if (new Set(rows.map((row) => row.id)).size !== rows.length) {
      throw new Error(`Retrieval ${name} contains duplicate ids.`);
    }
  }
  if (data.qrels.some((row) => typeof row?.queryId !== 'string' || !row.queryId ||
    typeof row.docId !== 'string' || !row.docId ||
    !Number.isInteger(row.score) || row.score < 0)) {
    throw new Error('Retrieval judgments require queryId, docId, and a nonnegative integer score.');
  }
  return data;
}

function scoreRetrieval(corpus, queries, qrels, documentVectors, queryVectors, k = 10) {
  const relevant = new Map();
  for (const row of qrels) {
    if (!Number.isFinite(row.score) || row.score <= 0) continue;
    const ids = relevant.get(row.queryId) ?? new Map();
    ids.set(row.docId, row.score);
    relevant.set(row.queryId, ids);
  }
  const corpusIds = new Set(corpus.map((row) => row.id));
  let recall = 0;
  let ndcg = 0;
  for (let i = 0; i < queries.length; i++) {
    const labels = relevant.get(queries[i].id);
    if (!labels?.size || [...labels.keys()].some((id) => !corpusIds.has(id))) {
      throw new Error(`Query ${queries[i].id} has no complete positive judgments in the corpus.`);
    }
    const ranking = documentVectors.map((vector, index) => {
      let dot = 0;
      for (let component = 0; component < vector.length; component++) {
        dot += vector[component] * queryVectors[i][component];
      }
      return { id: corpus[index].id, score: dot };
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
    const retrieved = ranking.filter((row) => labels.has(row.id));
    recall += retrieved.length / labels.size;
    const gain = (score) => 2 ** score - 1;
    const dcg = ranking.reduce((sum, row, rank) =>
      sum + gain(labels.get(row.id) ?? 0) / Math.log2(rank + 2), 0);
    const ideal = [...labels.values()].sort((a, b) => b - a).slice(0, k)
      .reduce((sum, score, rank) => sum + gain(score) / Math.log2(rank + 2), 0);
    ndcg += dcg / ideal;
  }
  return { queries: queries.length, corpus: corpus.length, recallAt10: recall / queries.length,
    ndcgAt10: ndcg / queries.length };
}

async function evaluateRetrieval(endpoint, model, file, onBatch = () => {}) {
  const { corpus, queries: allQueries, qrels } = readRetrievalDataset(file);
  const judged = new Set(qrels.filter((row) => row.score > 0).map((row) => row.queryId));
  const queries = allQueries.filter((row) => judged.has(row.id));
  if (!queries.length) throw new Error('No test queries have positive judgments.');
  const truncatedDocuments = corpus.filter((row) => row.text.length > 8192).length;
  const instruction = 'Given a scientific claim, retrieve scientific article abstracts that provide evidence for or against the claim';
  let dimensions;
  async function embed(rows, kind) {
    const vectors = [];
    for (let offset = 0; offset < rows.length; offset += 32) {
      const inputs = rows.slice(offset, offset + 32).map((row) =>
        kind === 'query' ? `Instruct: ${instruction}\nQuery: ${row.text}` : row.text.slice(0, 8192));
      if (inputs.some((input) => !input.trim() || input.length > 8192)) {
        throw new Error(`A ${kind} input exceeds Flint's 8192-character embedding limit.`);
      }
      const response = await fetch(`${endpoint}/embeddings`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: inputs }),
        signal: AbortSignal.timeout(3 * 60 * 1000),
      });
      if (!response.ok) throw new Error(`${kind} embeddings failed: HTTP ${response.status}: ${await response.text()}`);
      const body = await response.json();
      const batch = body?.data;
      if (!Array.isArray(batch) || batch.length !== inputs.length ||
        batch.some((row, index) => row?.index !== index || !Array.isArray(row.embedding) ||
          !row.embedding.length || row.embedding.some((value) => !Number.isFinite(value)))) {
        throw new Error(`${kind} embeddings returned an invalid OpenAI-shaped batch.`);
      }
      for (const row of batch) {
        if (dimensions !== undefined && dimensions !== row.embedding.length) {
          throw new Error('Embedding dimensions changed between batches.');
        }
        dimensions = row.embedding.length;
        const norm = Math.hypot(...row.embedding);
        if (!Number.isFinite(norm) || norm === 0) throw new Error('Embedding has zero or invalid norm.');
        vectors.push(row.embedding.map((value) => value / norm));
      }
      onBatch({ kind, completed: vectors.length, total: rows.length });
    }
    return vectors;
  }
  const documents = await embed(corpus, 'document');
  const questionVectors = await embed(queries, 'query');
  return { ...scoreRetrieval(corpus, queries, qrels, documents, questionVectors), dimensions,
    judgments: qrels.length, instruction, truncatedDocuments };
}

export { evaluateRetrieval, readRetrievalDataset, scoreRetrieval };
