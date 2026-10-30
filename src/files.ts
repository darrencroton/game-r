import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ENGINE_FILES } from './workspace.ts';

const MAX_VIEW_CHARS = 60_000;

export interface Roots {
  memory: string;
  run: string;
  runs: string;
}

interface Resolved {
  abs: string;
  root: keyof Roots;
  rel: string;
}

export class FilesError extends Error {}

export class Files {
  private readonly roots: () => Roots;

  constructor(roots: () => Roots) {
    this.roots = roots;
  }

  resolve(virtual: string, write: boolean): Resolved {
    const clean = path.posix.normalize('/' + virtual.trim().replace(/\\/g, '/'));
    const [, rootName = '', ...rest] = clean.split('/');
    if (!['memory', 'run', 'runs'].includes(rootName)) throw new FilesError(`Paths must start with /memory, /run or /runs (got "${virtual}").`);
    const root = rootName as keyof Roots;
    const rel = rest.join('/');
    if (root === 'runs') {
      if (write) throw new FilesError('/runs is read-only.');
      if (rel && !/^run-\d+(\/|$)/.test(rel)) throw new FilesError('Under /runs only run-NNN folders are visible.');
    }
    if (write && root === 'run' && ENGINE_FILES.has(rel.split('/')[0] ?? '')) throw new FilesError(`/run/${rel.split('/')[0]} is written by the engine and is read-only.`);
    if (write && !rel) throw new FilesError(`Cannot write to the root /${root}.`);
    const base = this.roots()[root];
    const abs = path.resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + path.sep)) throw new FilesError(`Path escapes /${root}.`);
    return { abs, root, rel };
  }

  async view(p: string, range?: [number, number]): Promise<string> {
    const { abs, root, rel } = this.resolve(p, false);
    const info = await stat(abs).catch(() => null);
    if (!info) throw new FilesError(`${p} does not exist.`);
    if (info.isDirectory()) return this.listing(abs, `/${root}${rel ? '/' + rel : ''}`, root === 'runs' && !rel);
    let text = await readFile(abs, 'utf8');
    const lines = text.split('\n');
    const [from, to] = range ?? [1, lines.length];
    const start = Math.max(1, from);
    const end = to === -1 ? lines.length : Math.min(lines.length, to);
    text = lines
      .slice(start - 1, end)
      .map((line, i) => `${String(start + i).padStart(6)}\t${line}`)
      .join('\n');
    if (text.length > MAX_VIEW_CHARS) text = text.slice(0, MAX_VIEW_CHARS) + `\n… truncated; use view_range to read the rest (${lines.length} lines).`;
    return text;
  }

  private async listing(abs: string, label: string, runsOnly: boolean): Promise<string> {
    const out: string[] = [`${label}/`];
    const walk = async (dir: string, depth: number, indent: string): Promise<void> => {
      const entries = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => !e.name.startsWith('.') && (!runsOnly || depth > 0 || /^run-\d+$/.test(e.name)))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const count = (await readdir(full)).length;
          out.push(`${indent}${entry.name}/ (${count} items)`);
          if (depth < 1 && entry.name !== 'shots') await walk(full, depth + 1, indent + '  ');
        } else {
          const info = await stat(full);
          out.push(`${indent}${entry.name} (${formatSize(info.size)}, changed ${info.mtime.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short', hour12: false })})`);
        }
      }
    };
    await walk(abs, 0, '  ');
    return out.length === 1 ? `${label}/ (empty)` : out.join('\n');
  }

  async create(p: string, text: string): Promise<string> {
    const { abs } = this.resolve(p, true);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, text);
    return `Wrote ${p} (${formatSize(Buffer.byteLength(text))}).`;
  }

  async strReplace(p: string, oldStr: string, newStr: string): Promise<string> {
    const { abs } = this.resolve(p, true);
    const text = await this.readExisting(abs, p);
    const count = text.split(oldStr).length - 1;
    if (count === 0) throw new FilesError(`old_str not found in ${p}.`);
    if (count > 1) throw new FilesError(`old_str occurs ${count} times in ${p}; include more context to make it unique.`);
    await writeFile(abs, text.replace(oldStr, () => newStr));
    return `Edited ${p}.`;
  }

  async insert(p: string, line: number, text: string): Promise<string> {
    const { abs } = this.resolve(p, true);
    const lines = (await this.readExisting(abs, p)).split('\n');
    if (line < 0 || line > lines.length) throw new FilesError(`insert_line must be between 0 and ${lines.length}.`);
    lines.splice(line, 0, ...text.replace(/\n$/, '').split('\n'));
    await writeFile(abs, lines.join('\n'));
    return `Inserted into ${p} after line ${line}.`;
  }

  async delete(p: string): Promise<string> {
    const { abs } = this.resolve(p, true);
    if (!(await stat(abs).catch(() => null))) throw new FilesError(`${p} does not exist.`);
    await rm(abs, { recursive: true });
    return `Deleted ${p}.`;
  }

  async rename(from: string, to: string): Promise<string> {
    const src = this.resolve(from, true);
    const dst = this.resolve(to, true);
    if (!(await stat(src.abs).catch(() => null))) throw new FilesError(`${from} does not exist.`);
    if (await stat(dst.abs).catch(() => null)) throw new FilesError(`${to} already exists.`);
    await mkdir(path.dirname(dst.abs), { recursive: true });
    await rename(src.abs, dst.abs);
    return `Renamed ${from} to ${to}.`;
  }

  private async readExisting(abs: string, p: string): Promise<string> {
    try {
      return await readFile(abs, 'utf8');
    } catch {
      throw new FilesError(`${p} does not exist; use create.`);
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
