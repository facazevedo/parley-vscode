import { promises as fsp } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Logger } from '../logging/logger';
import { dbg } from '../debug/debug';

/**
 * Optional local semantic index for `@codebase`, using a bundled MiniLM model via
 * transformers.js (ONNX/WASM) — no API key, runs offline after a one-time model
 * download. It's heavy (the dependency is large) and entirely opt-in
 * (`parley.codebaseSearch.provider` = "local"); every path is defensive and the
 * caller falls back to lexical retrieval if anything here fails.
 */
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const MAX_CHARS_PER_FILE = 4000;

type Embedder = (texts: string[]) => Promise<number[][]>;

interface IndexEntry {
  path: string;
  vec: number[];
}

// tsc would downlevel a normal `import()` to require() (which can't load this ESM-only
// package); this keeps a real runtime dynamic import.
const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;

export class EmbeddingIndex {
  private embedder?: Embedder;
  private entries: IndexEntry[] = [];
  private loadedRoot = '';

  public constructor(
    private readonly globalStorageUri: vscode.Uri,
    private readonly logger: Logger
  ) {}

  private indexFile(root: string): vscode.Uri {
    const safe = root.replace(/[^a-zA-Z0-9]/g, '_').slice(-80);
    return vscode.Uri.joinPath(this.globalStorageUri, 'codebase', `${safe}.json`);
  }

  /** Lazily load transformers.js + the MiniLM pipeline (downloaded/cached to global storage). */
  private async getEmbedder(): Promise<Embedder> {
    if (this.embedder) {
      return this.embedder;
    }
    const mod = (await dynamicImport('@xenova/transformers')) as {
      pipeline: (task: string, model: string) => Promise<(input: string[], opts: object) => Promise<{ data: Float32Array; dims: number[] }>>;
      env: { allowRemoteModels: boolean; cacheDir: string };
    };
    mod.env.allowRemoteModels = true;
    mod.env.cacheDir = vscode.Uri.joinPath(this.globalStorageUri, 'models').fsPath;
    const extractor = await mod.pipeline('feature-extraction', MODEL);
    this.embedder = async (texts: string[]) => {
      const out = await extractor(texts, { pooling: 'mean', normalize: true });
      const [n, d] = out.dims;
      const vecs: number[][] = [];
      for (let i = 0; i < n; i += 1) {
        vecs.push(Array.from(out.data.slice(i * d, (i + 1) * d)));
      }
      return vecs;
    };
    return this.embedder;
  }

  /** Build (and persist) the index from the given files. Returns the number indexed. */
  public async build(root: string, docs: ReadonlyArray<{ path: string; text: string }>): Promise<number> {
    const embed = await this.getEmbedder();
    const entries: IndexEntry[] = [];
    const BATCH = 16;
    for (let i = 0; i < docs.length; i += BATCH) {
      const batch = docs.slice(i, i + BATCH);
      const vecs = await embed(batch.map((d) => d.text.slice(0, MAX_CHARS_PER_FILE)));
      batch.forEach((d, j) => entries.push({ path: d.path, vec: vecs[j] }));
    }
    this.entries = entries;
    this.loadedRoot = root;
    try {
      const file = this.indexFile(root);
      await fsp.mkdir(path.dirname(file.fsPath), { recursive: true });
      await fsp.writeFile(file.fsPath, JSON.stringify({ root, entries }), 'utf8');
    } catch (error) {
      this.logger.warn(`Could not persist codebase index: ${error instanceof Error ? error.message : 'error'}`);
    }
    dbg('codebase', 'index built', { files: entries.length });
    return entries.length;
  }

  private async ensureLoaded(root: string): Promise<void> {
    if (this.loadedRoot === root && this.entries.length > 0) {
      return;
    }
    try {
      const raw = await fsp.readFile(this.indexFile(root).fsPath, 'utf8');
      const parsed = JSON.parse(raw) as { entries?: IndexEntry[] };
      this.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      this.loadedRoot = root;
    } catch {
      this.entries = [];
    }
  }

  /** Semantic search → top-N file paths, or `undefined` if no index exists / it fails. */
  public async search(root: string, query: string, topN: number): Promise<string[] | undefined> {
    try {
      await this.ensureLoaded(root);
      if (this.entries.length === 0) {
        return undefined; // not indexed yet
      }
      const embed = await this.getEmbedder();
      const [q] = await embed([query]);
      const scored = this.entries.map((e) => ({ path: e.path, score: dot(q, e.vec) }));
      return scored.sort((a, b) => b.score - a.score).slice(0, topN).map((s) => s.path);
    } catch (error) {
      this.logger.warn(`Semantic codebase search failed: ${error instanceof Error ? error.message : 'error'}`);
      return undefined;
    }
  }
}

/** Dot product (vectors are L2-normalized, so this is cosine similarity). */
function dot(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}
