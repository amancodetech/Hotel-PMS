import { createHash } from 'node:crypto';
import {
  isSetupTemplateCode,
  setupTemplateFor,
  type SetupTemplateCode,
} from './setup.js';

export const SETUP_IMPORT_MAX_BYTES = 256 * 1024;
export const SETUP_IMPORT_MAX_ROWS = 500;
export const SETUP_IMPORT_TEMPLATES: readonly SetupTemplateCode[] = [
  'ROOM',
  'CABIN',
  'TENT',
  'VILLA',
  'APARTMENT',
  'SITE',
];
const unsafeFormula = /^[=+\-@]/;
const codePattern = /^[A-Z0-9][A-Z0-9\-/]{0,79}$/;

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 && code !== 9) return true;
  }
  return false;
}

function safeCell(value: string): boolean {
  return !unsafeFormula.test(value) && !hasControlChars(value);
}

export interface SetupImportRow {
  line_no: number;
  code: string | null;
  template_code: SetupTemplateCode | null;
  capacity: number | null;
  location_code: string | null;
  status: 'ACCEPTED' | 'REJECTED' | 'CREATED';
  error_code: string | null;
}

export interface SetupImportParseResult {
  file_hash: string;
  file_error: string | null;
  rows: SetupImportRow[];
}

function reject(row: SetupImportRow, code: string): SetupImportRow {
  return { ...row, status: 'REJECTED', error_code: code };
}

export function parseSetupUnitsCsv(content: string): SetupImportParseResult {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes === 0) return { file_hash: '', file_error: 'EMPTY_FILE', rows: [] };
  if (bytes > SETUP_IMPORT_MAX_BYTES)
    return { file_hash: '', file_error: 'FILE_TOO_LARGE', rows: [] };
  const fileHash = createHash('sha256').update(content).digest('hex');
  const text = content.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0)
    return { file_hash: fileHash, file_error: 'EMPTY_FILE', rows: [] };
  const headerCells = lines[0]!
    .split(',')
    .map((cell) => cell.trim().toLowerCase());
  if (
    headerCells.length !== 4 ||
    headerCells[0] !== 'code' ||
    headerCells[1] !== 'template' ||
    headerCells[2] !== 'capacity' ||
    headerCells[3] !== 'location'
  )
    return { file_hash: fileHash, file_error: 'HEADER_INVALID', rows: [] };
  if (lines.length - 1 > SETUP_IMPORT_MAX_ROWS)
    return { file_hash: fileHash, file_error: 'TOO_MANY_ROWS', rows: [] };

  const rows: SetupImportRow[] = [];
  const seen = new Set<string>();
  for (const [index, line] of lines.slice(1).entries()) {
    const lineNo = index + 2;
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length !== 4) {
      rows.push({
        line_no: lineNo,
        code: null,
        template_code: null,
        capacity: null,
        location_code: null,
        status: 'REJECTED',
        error_code: 'COLUMN_COUNT',
      });
      continue;
    }
    const [rawCode = '', rawTemplate = '', rawCapacity = '', rawLocation = ''] =
      cells;
    let row: SetupImportRow = {
      line_no: lineNo,
      code: rawCode.toUpperCase(),
      template_code: null,
      capacity: null,
      location_code: rawLocation === '' ? null : rawLocation,
      status: 'ACCEPTED',
      error_code: null,
    };
    if (
      !safeCell(rawCode) ||
      !safeCell(rawTemplate) ||
      !safeCell(rawCapacity) ||
      !safeCell(rawLocation)
    ) {
      rows.push(reject(row, 'UNSAFE_CONTENT'));
      continue;
    }
    if (!codePattern.test(row.code ?? '')) {
      rows.push(reject(row, 'CODE_INVALID'));
      continue;
    }
    const template = rawTemplate.toUpperCase();
    if (!isSetupTemplateCode(template)) {
      rows.push(reject(row, 'TEMPLATE_UNKNOWN'));
      continue;
    }
    if (!SETUP_IMPORT_TEMPLATES.includes(template)) {
      rows.push(reject(row, 'TEMPLATE_UNSUPPORTED'));
      continue;
    }
    row = { ...row, template_code: template };
    if (rawCapacity !== '') {
      const capacity = Number(rawCapacity);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) {
        rows.push(reject(row, 'CAPACITY_INVALID'));
        continue;
      }
      row = { ...row, capacity };
    }
    if (seen.has(row.code!)) {
      rows.push({
        ...row,
        status: 'REJECTED',
        error_code: 'DUPLICATE_IN_FILE',
      });
      continue;
    }
    seen.add(row.code!);
    rows.push(row);
  }
  return { file_hash: fileHash, file_error: null, rows };
}

export function setupImportRowResourceType(row: SetupImportRow): {
  resourceType: string;
  capacity: number;
} {
  const template = setupTemplateFor(row.template_code!);
  return {
    resourceType: template?.resourceType ?? 'ROOM',
    capacity: row.capacity ?? template?.defaultCapacity ?? 2,
  };
}
