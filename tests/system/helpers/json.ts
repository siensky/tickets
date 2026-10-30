/**
 * Smal, typad läsning av JSON-svar utan att importera något från
 * `services/` eller `shared/`: testerna känner bara till kontraktet.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected a JSON object, got ${JSON.stringify(value)}`);
  }
  return Object.fromEntries(Object.entries(value));
}

export function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected a JSON array, got ${JSON.stringify(value)}`);
  }
  return [...(value as readonly unknown[])];
}

export function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected string at "${key}", got ${JSON.stringify(value)}`);
  }
  return value;
}

export function num(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number') {
    throw new Error(`Expected number at "${key}", got ${JSON.stringify(value)}`);
  }
  return value;
}
