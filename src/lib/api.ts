import { validateResponse } from "./validation";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "./types";
export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return String(error);
}
export async function api<T>(
  method: string,
  payload: unknown = {},
): Promise<T> {
  if (!isTauri())
    throw {
      code: "DESKTOP_REQUIRED",
      message:
        "Open Kitsune with bun run tauri dev to use database connections. The browser preview cannot access databases.",
    } satisfies ApiError;
  return validateResponse(
    method,
    await invoke<unknown>("api", { method, payload }),
  ) as T;
}
// Small request cache while dependency downloads are unavailable. Never stores credentials.
const cache = new Map<string, unknown>();
const cacheSizes = new Map<string, number>();
let cacheBytes = 0;
function cacheValue(key: string, value: unknown) {
  if (cache.has(key)) {
    cacheBytes -= cacheSizes.get(key) || 0;
    cache.delete(key);
    cacheSizes.delete(key);
  }
  const bytes = JSON.stringify(value).length * 3;
  if (bytes > 24 * 1024 * 1024) return;
  cache.set(key, value);
  cacheSizes.set(key, bytes);
  cacheBytes += bytes;
  while (cacheBytes > 24 * 1024 * 1024 || cache.size > 40) {
    const first = cache.keys().next().value as string;
    cacheBytes -= cacheSizes.get(first) || 0;
    cache.delete(first);
    cacheSizes.delete(first);
  }
}

export function invalidate(prefix = "") {
  for (const key of cache.keys())
    if (key.startsWith(prefix)) {
      cache.delete(key);
      cacheBytes -= cacheSizes.get(key) || 0;
      cacheSizes.delete(key);
    }
  window.dispatchEvent(
    new CustomEvent("kitsune:invalidate", { detail: prefix }),
  );
}
export function useRemote<T>(
  method: string,
  payload: unknown,
  enabled = true,
  interval = 0,
) {
  const key = `${method}:${JSON.stringify(payload)}`;
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const version = useRef(0);
  const running = useRef<{ key: string; version: number } | null>(null);
  const refresh = useCallback(
    async (force = true) => {
      if (!enabled || running.current?.key === key) return;
      const n = ++version.current;
      running.current = { key, version: n };
      setLoading(true);
      setError("");
      try {
        const value = await api<T>(method, {
          ...(JSON.parse(key.slice(method.length + 1)) as object),
          refresh: force,
        });
        if (version.current === n) {
          cacheValue(key, value);
          setData(value);
        }
      } catch (e) {
        if (version.current === n) setError(errorMessage(e));
      } finally {
        if (running.current?.version === n) running.current = null;
        if (version.current === n) setLoading(false);
      }
    },
    [key, method, enabled],
  );
  useEffect(() => {
    setData(enabled ? (cache.get(key) as T | undefined) : undefined);
    if (enabled) void refresh(false);
    else setLoading(false);
    return () => {
      version.current++;
      running.current = null;
    };
  }, [key, enabled, refresh]);
  useEffect(() => {
    if (!interval || !enabled) return;
    const id = window.setInterval(() => void refresh(false), interval);
    return () => window.clearInterval(id);
  }, [refresh, enabled, interval]);
  useEffect(() => {
    const listener = (event: Event) => {
      if (key.startsWith((event as CustomEvent<string>).detail)) void refresh();
    };
    window.addEventListener("kitsune:invalidate", listener);
    return () => window.removeEventListener("kitsune:invalidate", listener);
  }, [key, refresh]);
  return { data, error, loading, refresh };
}
export async function copy(text: string) {
  await navigator.clipboard.writeText(text);
}
