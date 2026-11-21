export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.length) throw new Error(`Missing ${field}`);
  return value;
}
