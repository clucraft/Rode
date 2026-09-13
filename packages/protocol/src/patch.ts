import { z } from 'zod';

/*
 * A PATCH body must carry only the keys the caller sent. In zod 4,
 * `.partial()` on an object whose fields have `.default()` still applies
 * those defaults to the missing keys, so a partial body silently reset every
 * other setting to its default on the server. `patchOf` strips the defaults
 * first and makes every field optional, so a missing key stays missing.
 */

type StripDefault<T> = T extends z.ZodDefault<infer U> ? StripDefault<U> : T;
type PatchShape<T extends z.ZodRawShape> = { [K in keyof T]: z.ZodOptional<StripDefault<T[K]>> };

export function patchOf<T extends z.ZodRawShape>(obj: z.ZodObject<T>): z.ZodObject<PatchShape<T>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(obj.shape)) {
    let s = v as z.ZodType;
    while (s instanceof z.ZodDefault) s = (s as z.ZodDefault<z.ZodType>).unwrap();
    shape[k] = s.optional();
  }
  return z.object(shape) as unknown as z.ZodObject<PatchShape<T>>;
}
