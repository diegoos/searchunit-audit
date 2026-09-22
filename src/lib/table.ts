import Table from 'cli-table3';
import { useAsciiMarks } from './theme.ts';

const MIN_COL = 3;
const INDENT = 2;
const PAD = 1;

/** Cap on auto-sized front columns so long titles wrap instead of stretching the table. */
const FRONT_CAP = 32;

/** Double outer box, single inner rules (cli-table3 basic-usage.md). */
const BOX_CHARS = {
  top: '═',
  'top-mid': '╤',
  'top-left': '╔',
  'top-right': '╗',
  bottom: '═',
  'bottom-mid': '╧',
  'bottom-left': '╚',
  'bottom-right': '╝',
  left: '║',
  'left-mid': '╟',
  mid: '─',
  'mid-mid': '┼',
  right: '║',
  'right-mid': '╢',
  middle: '│',
} as const;

/** Visible column width, ignoring ANSI SGR sequences. */
export function visibleWidth(text: string): number {
  let width = 0;

  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 27 && text[i + 1] === '[') {
      const end = text.indexOf('m', i + 2);

      if (end === -1) {
        break;
      }

      i = end;
      continue;
    }

    width++;
  }

  return width;
}

/** Terminal columns for TTY tables; 80 when stdout has no usable width. */
export function tableColumns(): number {
  const cols = process.stdout.columns;

  return cols && cols >= 60 ? cols : 80;
}

function naturalInnerWidths(headers: string[], rows: string[][]): number[] {
  return headers.map((header, i) => {
    let width = visibleWidth(header);

    for (const row of rows) {
      width = Math.max(width, visibleWidth(row[i] ?? ''));
    }

    return Math.max(width, MIN_COL) + 2 * PAD;
  });
}

/**
 * Front columns stay `null` (auto-size, no wrap) unless they exceed FRONT_CAP.
 * The last column is numbered so wordWrap runs there only.
 */

function planColWidths(headers: string[], rows: string[][]): (number | null)[] {
  const n = headers.length;
  const inner = naturalInnerWidths(headers, rows);
  const front = inner.slice(0, -1).map((w) => (w > FRONT_CAP ? FRONT_CAP : null));
  const used = front.reduce((sum, w, i) => sum + (w ?? inner[i]!), 0);
  const last = Math.max(MIN_COL, tableColumns() - INDENT - (n + 1) - used);

  return [...front, last];
}

/** Indents every line of a block (empty string stays empty). */

function indentBlock(block: string): string {
  if (!block) {
    return '';
  }

  return block
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/**
 * Renders a bordered TTY table via cli-table3.
 * Headers are plain strings; `style.head` colors them after layout so SGR is
 * not sliced by textWrap (`string.length`).
 */
export function formatTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) {
    return '';
  }

  const table = new Table({
    head: headers,
    colWidths: planColWidths(headers, rows),
    colAligns: headers[0] === 'Status' ? ['center'] : [],
    wordWrap: true,
    wrapOnWordBoundary: false,
    style: {
      head: useAsciiMarks() ? [] : ['dim'],
      border: [],
      'padding-left': PAD,
      'padding-right': PAD,
    },
    chars: BOX_CHARS,
  });
  for (const row of rows) {
    table.push(row);
  }

  return indentBlock(table.toString());
}
