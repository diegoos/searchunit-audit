/**
 * Vertical spacing for TS sources (idempotent with oxfmt).
 * `--check` reports files that would change and exits 1; it does not write.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const TARGETS = ['src', 'tests', 'scripts'].map((dir) => path.join(ROOT, dir));

type StmtKind = 'decl' | 'control' | 'return' | 'throw' | 'import' | 'other';

interface StmtMeta {
  kind: StmtKind;
  indent: number;
}

function collectTsFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(dir, name));
}

function getIndent(line: string): number {
  return line.length - line.trimStart().length;
}

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

function classifyTrimmed(trimmed: string): StmtKind {
  if (trimmed === '}' || /^(if|for|while|switch|try|do)\b/.test(trimmed)) {
    return 'control';
  }

  if (/^import\s/.test(trimmed) || (/^export\s/.test(trimmed) && trimmed.includes(' from '))) {
    return 'import';
  }

  if (/^(const|let|var)\b/.test(trimmed)) {
    return 'decl';
  }

  if (/^return\b/.test(trimmed)) {
    return 'return';
  }

  if (/^throw\b/.test(trimmed)) {
    return 'throw';
  }

  return 'other';
}

function endsStatement(trimmed: string): boolean {
  return trimmed === '}' || trimmed.split('//')[0]!.trimEnd().endsWith(';');
}

function isContinuation(trimmed: string): boolean {
  if (trimmed.startsWith('}') && trimmed !== '}') {
    return true;
  }

  return /^(\.|\)|,|\]|&&|\|\||\?|:)/.test(trimmed);
}

function scanBackticks(line: string, inTemplate: boolean): boolean {
  let inT = inTemplate;

  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') {
      i += 1;
      continue;
    }

    if (line[i] === '`') {
      inT = !inT;
    }
  }

  return inT;
}

function needsBlankBetween(prev: StmtMeta, next: StmtMeta, nextTrimmed: string): boolean {
  if (
    nextTrimmed === '}' ||
    nextTrimmed.startsWith('else') ||
    isContinuation(nextTrimmed) ||
    prev.indent !== next.indent
  ) {
    return false;
  }

  if (prev.kind === 'import' && next.kind !== 'import') {
    return true;
  }

  if (prev.kind === 'decl' && next.kind !== 'decl') {
    return true;
  }

  if (prev.kind === 'control') {
    return true;
  }

  return (
    prev.kind === 'other' &&
    (next.kind === 'return' || next.kind === 'control' || next.kind === 'throw')
  );
}

function cleanupArtifacts(text: string): string {
  return text
    .replace(/(\/\/ eslint-disable-next-line[^\n]*)\n\n/g, '$1\n')
    .replace(/^(\s+}[)\]},;]+)\n\n(?!\s*(?:return|throw)\b)(\s+\S)/gm, '$1\n$2')
    .replace(/^(\s+],)\n\n(\s+\S)/gm, '$1\n$2')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n\n(\s*}\n)/g, '\n$1');
}

function applyVerticalSpacing(text: string): string {
  const out: string[] = [];
  let prev: StmtMeta | null = null;
  let inTemplate = false;

  for (const line of text.split('\n')) {
    const startedInTemplate = inTemplate;
    inTemplate = scanBackticks(line, inTemplate);
    const trimmed = line.trim();

    if (!trimmed) {
      out.push(line);
      continue;
    }

    if (startedInTemplate || inTemplate) {
      out.push(line);
      prev = null;
      continue;
    }

    if (isCommentLine(trimmed)) {
      out.push(line);

      if (trimmed.includes('*/')) {
        prev = null;
      }

      continue;
    }

    const indent = getIndent(line);
    const kind = classifyTrimmed(trimmed);

    const last = out.at(-1);

    if (
      prev &&
      last?.trim() &&
      !last.includes('eslint-disable-next-line') &&
      needsBlankBetween(prev, { kind, indent }, trimmed)
    ) {
      out.push('');
    }

    out.push(line);

    if (trimmed.endsWith('{')) {
      prev = null;
      continue;
    }

    if (endsStatement(trimmed)) {
      prev = { kind, indent };
    }
  }

  return cleanupArtifacts(out.join('\n'));
}

const checkOnly = process.argv.includes('--check');

function formatFile(filePath: string): boolean {
  const original = fs.readFileSync(filePath, 'utf8');
  const next = applyVerticalSpacing(original);

  if (next === original) {
    return false;
  }

  if (!checkOnly) {
    fs.writeFileSync(filePath, next);
  }

  return true;
}

let changed = 0;

for (const dir of TARGETS) {
  for (const file of collectTsFiles(dir)) {
    if (formatFile(file)) {
      changed++;
    }
  }
}

console.log(`vertical spacing: ${changed} file(s) ${checkOnly ? 'would change' : 'updated'}`);

if (checkOnly && changed > 0) {
  process.exitCode = 1;
}
