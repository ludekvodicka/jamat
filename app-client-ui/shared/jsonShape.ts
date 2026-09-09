/**
 * The first question every validator in this package asks of something it did not build: is this a
 * JSON object at all?
 *
 * A package-local copy of the library's class of the same name, for the same reason `errorText` is
 * one: the renderer reads it, and the renderer imports no library code as a value. Two shapes
 * because both are wanted: a guard for a condition, and a narrowed value or null for a chain of
 * field reads. `null` is not a record and neither is an array, which is the whole content of the
 * check and the reason `typeof x === 'object'` alone is never enough.
 */
export class JsonShape {
  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  static record(value: unknown): Record<string, unknown> | null {
    return JsonShape.isRecord(value) ? value : null
  }
}
