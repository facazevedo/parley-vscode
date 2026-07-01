import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fsp } from 'fs';
import { chunkText } from './chunk';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';
import type { Logger } from '../logging/logger';
import { dbg } from '../debug/debug';

/**
 * Optional local semantic index for `@codebase`, using a MiniLM model via
 * transformers.js (ONNX) — no API key, runs offline after a one-time model
 * download. It's entirely opt-in (`parley.codebaseSearch.provider` = "local").
 *
 * The transformers.js runtime is large and platform-specific (it pulls native
 * `onnxruntime-node`/`sharp` binaries), so it is NOT shipped in the VSIX. Instead
 * it's installed on demand into the extension's global storage the first time you
 * build the index — that way the base extension stays small and platform-agnostic,
 * and the native binaries fetched match your machine. Requires `npm` on PATH for
 * that one-time install. Every path here is defensive: the caller falls back to
 * lexical retrieval if anything fails.
 */
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const TRANSFORMERS_VERSION = '2.17.2';

type Embedder = (texts: string[]) => Promise<number[][]>;

interface TransformersModule {
  pipeline: (
    task: string,
    model: string
  ) => Promise<(input: string[], opts: object) => Promise<{ data: Float32Array; dims: number[] }>>;
  env: { allowRemoteModels: boolean; cacheDir: string };
}

interface ChunkEntry {
  /** 1-based first line of the chunk. */
  s: number;
  vec: number[];
}

interface FileEntry {
  /** Content hash — unchanged files are reused instead of re-embedded. */
  hash: string;
  chunks: ChunkEntry[];
}

/** v2 index: per-file hash + ~60-line chunk vectors (v1 was one vector per file). */
interface IndexFileFormat {
  root: string;
  version?: number;
  files?: Record<string, FileEntry>;
  /** Legacy v1 entries — migrated to single-chunk files with a stale hash. */
  entries?: Array<{ path: string; vec: number[] }>;
}

// tsc would downlevel a normal `import()` to require() (which can't load this ESM-only
// package); this keeps a real runtime dynamic import.
const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;

export class EmbeddingIndex {
  private embedder?: Embedder;
  private files = new Map<string, FileEntry>();
  private loadedRoot = '';

  public constructor(
    private readonly globalStorageUri: vscode.Uri,
    private readonly logger: Logger
  ) {}

  private indexFile(root: string): vscode.Uri {
    const safe = root.replace(/[^a-zA-Z0-9]/g, '_').slice(-80);
    return vscode.Uri.joinPath(this.globalStorageUri, 'codebase', `${safe}.json`);
  }

  /** Directory where the transformers.js runtime is installed on demand. */
  private get runtimeDir(): string {
    return vscode.Uri.joinPath(this.globalStorageUri, 'runtime').fsPath;
  }

  /** True if the transformers.js runtime has already been installed locally. */
  private async isRuntimeInstalled(): Promise<boolean> {
    try {
      await fsp.access(path.join(this.runtimeDir, 'node_modules', '@xenova', 'transformers', 'package.json'));
      return true;
    } catch {
      return false;
    }
  }

  /** Install transformers.js into global storage via npm (one-time, ~hundreds of MB). */
  private async installRuntime(): Promise<void> {
    await fsp.mkdir(this.runtimeDir, { recursive: true });
    // A private package.json so npm installs locally into runtimeDir/node_modules.
    await fsp.writeFile(
      path.join(this.runtimeDir, 'package.json'),
      JSON.stringify({ name: 'parley-runtime', private: true, version: '1.0.0' }),
      'utf8'
    );
    dbg('codebase', 'installing transformers runtime', { dir: this.runtimeDir });
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Parley: installing the local embedding runtime (one-time, this may take a few minutes)…',
        cancellable: false
      },
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            'npm',
            ['install', `@xenova/transformers@${TRANSFORMERS_VERSION}`, '--no-audit', '--no-fund', '--loglevel=error'],
            { cwd: this.runtimeDir, shell: true }
          );
          let stderr = '';
          child.stderr?.on('data', (d) => {
            stderr += d.toString();
          });
          child.on('error', (err) => reject(new Error(`Could not run npm (is it on your PATH?): ${err.message}`)));
          child.on('close', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`npm install exited with code ${code}. ${stderr.slice(-400)}`));
            }
          });
        })
    );
  }

  /**
   * Import the installed transformers.js. Uses a tiny ESM shim placed beside the
   * install so the bare specifier resolves against runtimeDir/node_modules
   * regardless of the package's export conditions.
   */
  private async loadTransformers(): Promise<TransformersModule> {
    const shim = path.join(this.runtimeDir, 'load-transformers.mjs');
    await fsp.writeFile(shim, "export * from '@xenova/transformers';\n", 'utf8');
    return (await dynamicImport(pathToFileURL(shim).href)) as TransformersModule;
  }

  /**
   * Lazily load transformers.js + the MiniLM pipeline. When `allowInstall` is true
   * (explicit index build) it installs the runtime on first use; otherwise (e.g. a
   * search) it throws if the runtime is absent so the caller falls back to lexical.
   */
  private async getEmbedder(allowInstall: boolean): Promise<Embedder> {
    if (this.embedder) {
      return this.embedder;
    }
    if (!(await this.isRuntimeInstalled())) {
      if (!allowInstall) {
        throw new Error('local embedding runtime not installed (run "Parley: Rebuild Codebase Index")');
      }
      await this.installRuntime();
    }
    const mod = await this.loadTransformers();
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

  private static hash(text: string): string {
    return createHash('sha1').update(text).digest('hex');
  }

  private async embedFile(embed: Embedder, text: string): Promise<ChunkEntry[]> {
    const chunks = chunkText(text);
    const out: ChunkEntry[] = [];
    const BATCH = 16;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const vecs = await embed(batch.map((c) => c.text));
      batch.forEach((c, j) => out.push({ s: c.startLine, vec: vecs[j] }));
    }
    return out;
  }

  /**
   * Build (and persist) the index. Incremental: files whose content hash matches
   * the existing index are reused, so a rebuild after small changes only embeds
   * what changed. Returns the number of files indexed.
   */
  public async build(root: string, docs: ReadonlyArray<{ path: string; text: string }>): Promise<number> {
    await this.ensureLoaded(root);
    const embed = await this.getEmbedder(true);
    const next = new Map<string, FileEntry>();
    let reused = 0;
    for (const doc of docs) {
      const hash = EmbeddingIndex.hash(doc.text);
      const existing = this.files.get(doc.path);
      if (existing && existing.hash === hash && existing.chunks.length > 0) {
        next.set(doc.path, existing);
        reused += 1;
        continue;
      }
      const chunks = await this.embedFile(embed, doc.text);
      if (chunks.length > 0) {
        next.set(doc.path, { hash, chunks });
      }
    }
    this.files = next;
    this.loadedRoot = root;
    await this.persist(root);
    dbg('codebase', 'index built', { files: next.size, reused });
    return next.size;
  }

  /**
   * Incrementally re-embed one file (on save). Only runs when the index for this
   * root is loaded AND the embedder is already in memory — a save never triggers
   * the heavy runtime/model load by itself.
   */
  public async updateFile(root: string, relPath: string, text: string): Promise<void> {
    if (!this.embedder || this.loadedRoot !== root || this.files.size === 0) {
      return;
    }
    try {
      const hash = EmbeddingIndex.hash(text);
      if (this.files.get(relPath)?.hash === hash) {
        return;
      }
      const chunks = await this.embedFile(this.embedder, text);
      if (chunks.length > 0) {
        this.files.set(relPath, { hash, chunks });
      } else {
        this.files.delete(relPath);
      }
      await this.persist(root);
      dbg('codebase', 'index updated on save', { file: relPath, chunks: chunks.length });
    } catch (error) {
      this.logger.debug(`Incremental index update failed: ${error instanceof Error ? error.message : 'error'}`);
    }
  }

  private async persist(root: string): Promise<void> {
    try {
      const file = this.indexFile(root);
      await fsp.mkdir(path.dirname(file.fsPath), { recursive: true });
      const payload: IndexFileFormat = { root, version: 2, files: Object.fromEntries(this.files) };
      await fsp.writeFile(file.fsPath, JSON.stringify(payload), 'utf8');
    } catch (error) {
      this.logger.warn(`Could not persist codebase index: ${error instanceof Error ? error.message : 'error'}`);
    }
  }

  private async ensureLoaded(root: string): Promise<void> {
    if (this.loadedRoot === root && this.files.size > 0) {
      return;
    }
    this.files = new Map();
    this.loadedRoot = root;
    try {
      const raw = await fsp.readFile(this.indexFile(root).fsPath, 'utf8');
      const parsed = JSON.parse(raw) as IndexFileFormat;
      if (parsed.files) {
        this.files = new Map(Object.entries(parsed.files));
      } else if (Array.isArray(parsed.entries)) {
        // v1 migration: one whole-file vector becomes a single chunk with a stale
        // hash, so the next build re-embeds it chunked but search works meanwhile.
        for (const e of parsed.entries) {
          this.files.set(e.path, { hash: '', chunks: [{ s: 1, vec: e.vec }] });
        }
      }
    } catch {
      // No index on disk yet.
    }
  }

  /** Semantic search → top-N file paths (best chunk per file), or `undefined` on failure. */
  public async search(root: string, query: string, topN: number): Promise<string[] | undefined> {
    try {
      await this.ensureLoaded(root);
      if (this.files.size === 0) {
        return undefined; // not indexed yet
      }
      const embed = await this.getEmbedder(false);
      const [q] = await embed([query]);
      const scored: Array<{ path: string; score: number }> = [];
      for (const [p, entry] of this.files) {
        let best = -Infinity;
        for (const chunk of entry.chunks) {
          const score = dot(q, chunk.vec);
          if (score > best) {
            best = score;
          }
        }
        if (best > -Infinity) {
          scored.push({ path: p, score: best });
        }
      }
      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, topN)
        .map((s) => s.path);
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
