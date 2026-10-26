import { useEffect, useRef, useState, type SetStateAction } from "react";
import { z } from "zod";
import { api, errorMessage } from "./api";
import { notify } from "./store";
const cache = new Map<string, unknown>();
function remember(key: string, value: unknown) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > 128) cache.delete(cache.keys().next().value as string);
}
export function useLayoutPreference<T>(
  key: string | undefined,
  schema: z.ZodType<T>,
  fallback: T,
): [T, (value: SetStateAction<T>) => void] {
  const initial = useRef(fallback);
  const parser = useRef(schema);
  parser.current = schema;
  const [value, setValue] = useState<T>(() => {
    const parsed = key ? schema.safeParse(cache.get(key)) : null;
    return parsed?.success ? parsed.data : fallback;
  });
  const current = useRef(value);
  const changed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    changed.current = false;
    const parsed = key ? parser.current.safeParse(cache.get(key)) : null;
    const next = parsed?.success ? parsed.data : initial.current;
    current.current = next;
    setValue(next);
    if (key)
      void api<unknown>("ui_state", { key })
        .then((data) => {
          const parsed = parser.current.safeParse(data);
          if (alive && !changed.current && parsed.success) {
            remember(key, parsed.data);
            current.current = parsed.data;
            setValue(parsed.data);
          }
        })
        .catch((e) => notify(errorMessage(e), true));
    return () => {
      alive = false;
      clearTimeout(timer.current);
      if (key && changed.current)
        void api("save_ui_state", { key, value: current.current }).catch((e) =>
          notify(errorMessage(e), true),
        );
    };
  }, [key]);
  function change(next: SetStateAction<T>) {
    const result =
      typeof next === "function"
        ? (next as (old: T) => T)(current.current)
        : next;
    current.current = result;
    changed.current = true;
    setValue(result);
    if (!key) return;
    remember(key, result);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void api("save_ui_state", { key, value: result }).catch((e) =>
        notify(errorMessage(e), true),
      );
    }, 400);
  }
  return [value, change];
}
export const gridLayoutSchema = z.object({
  hidden: z.array(z.string()).max(10000),
  order: z.array(z.string()).max(10000),
  widths: z.record(z.string(), z.number().min(80).max(900)),
});
export type GridLayout = z.infer<typeof gridLayoutSchema>;
export function reconciledColumns(
  columns: string[],
  layout: GridLayout,
): string[] {
  return [
    ...layout.order.filter(
      (name, i, a) => columns.includes(name) && a.indexOf(name) === i,
    ),
    ...columns.filter((name) => !layout.order.includes(name)),
  ];
}

export function columnPreferenceKeys(columns: string[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((name) => {
    const i = seen.get(name) || 0;
    seen.set(name, i + 1);
    return JSON.stringify([name, i]);
  });
}
