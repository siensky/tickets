/**
 * Minimal CSV-läsare för seed-filerna (docs/plan.md 7.6): RFC 4180 med citerade
 * fält ("" som escapad citationstecken, kommatecken och radbrytningar inom
 * citat). Ingen CSV-lib behövs (docs/rules.md §11: inga nya beroenden). Varje
 * post bär sitt radnummer i filen, så validering kan avbryta med rätt rad.
 */
export interface CsvRecord {
  readonly line: number;
  readonly values: Readonly<Record<string, string>>;
}

export class CsvParseError extends Error {}

function splitRows(text: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  const endRow = (): void => {
    cells.push(cell);
    if (cells.length > 1 || cells[0] !== '') {
      rows.push({ line: rowLine, cells });
    }
    cells = [];
    cell = '';
    rowLine = line + 1;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (inQuotes) {
      if (char === '"' && text.charAt(i + 1) === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
        if (char === '\n') line += 1;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text.charAt(i + 1) === '\n') i += 1;
      endRow();
      line += 1;
      rowLine = line;
    } else {
      cell += char;
    }
  }
  if (inQuotes) {
    throw new CsvParseError(`rad ${String(rowLine)}: ett citerat fält är aldrig avslutat`);
  }
  if (cell !== '' || cells.length > 0) endRow();
  return rows;
}

/** Läser en CSV med rubrikrad. Saknade eller okända kolumner avvisas direkt. */
export function parseCsv(text: string, expectedColumns: readonly string[]): CsvRecord[] {
  const rows = splitRows(text.replace(/^\uFEFF/, ''));
  const header = rows[0];
  if (header === undefined) {
    throw new CsvParseError('filen är tom');
  }
  const actual = header.cells.map((name) => name.trim());
  if (actual.join(',') !== expectedColumns.join(',')) {
    throw new CsvParseError(
      `rad 1: förväntade kolumnerna "${expectedColumns.join(',')}", fick "${actual.join(',')}"`,
    );
  }
  return rows.slice(1).map((row) => {
    if (row.cells.length !== actual.length) {
      throw new CsvParseError(
        `rad ${String(row.line)}: ${String(row.cells.length)} fält, förväntade ${String(actual.length)}`,
      );
    }
    return {
      line: row.line,
      values: Object.fromEntries(actual.map((name, index) => [name, row.cells[index] ?? ''])),
    };
  });
}
