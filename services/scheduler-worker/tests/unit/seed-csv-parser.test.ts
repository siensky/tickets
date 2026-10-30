import { describe, expect, it } from 'vitest';
import { CsvParseError, parseCsv } from '../../src/mappers/seed-csv-parser.js';

describe('parseCsv', () => {
  it('läser citerade fält med kommatecken, citattecken och radbrytningar, med radnummer', () => {
    const text = 'a,b\n1,"x, ""y"""\n2,"rad ett\nrad två"\n3,z\n';

    const records = parseCsv(text, ['a', 'b']);

    expect(records.map((record) => record.values)).toEqual([
      { a: '1', b: 'x, "y"' },
      { a: '2', b: 'rad ett\nrad två' },
      { a: '3', b: 'z' },
    ]);
    expect(records.map((record) => record.line)).toEqual([2, 3, 5]);
  });

  it('hanterar BOM, CRLF och tomma rader', () => {
    const records = parseCsv('﻿a,b\r\n1,2\r\n\r\n3,4', ['a', 'b']);

    expect(records.map((record) => record.values['b'])).toEqual(['2', '4']);
  });

  it('avvisar fel rubrik, fel antal fält och ett oavslutat citat', () => {
    expect(() => parseCsv('a,c\n1,2', ['a', 'b'])).toThrow(CsvParseError);
    expect(() => parseCsv('a,b\n1', ['a', 'b'])).toThrow(/rad 2/);
    expect(() => parseCsv('a,b\n1,"oavslutad', ['a', 'b'])).toThrow(/aldrig avslutat/);
  });
});
