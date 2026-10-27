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
const cacheTimes = new Map<string, number>();
type PendingRequest = { invalidated: boolean; promise: Promise<unknown> };
const inFlight = new Map<string, PendingRequest>();
let cacheBytes = 0;
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_BYTES = 24 * 1024 * 1024;
function cacheValue(key: string, value: unknown) {
  // Estimate table-page sizes without JSON serialization. Serialization here
  // used to copy large cell strings on the UI thread just to decide whether to
  // cache them.
  let bytes: number;
  if (key.startsWith("browse:")) {
    const result = value as {
      rows?: Array<Array<{ kind?: string; value?: unknown }>>;
    };
    if (!Array.isArray(result.rows)) return;
    bytes = 256;
    for (const row of result.rows) {
      for (const cell of row) {
        bytes += typeof cell.value === "string" ? cell.value.length * 2 : 16;
        if (bytes > 3 * 1024 * 1024) return;
      }
    }
  } else {
    try {
      bytes = JSON.stringify(value).length * 2;
    } catch {
      return;
    }
  }
  if (cache.has(key)) {
    cacheBytes -= cacheSizes.get(key) || 0;
    cache.delete(key);
    cacheSizes.delete(key);
    cacheTimes.delete(key);
  }
  if (bytes > 3 * 1024 * 1024) return;
  cache.set(key, value);
  cacheSizes.set(key, bytes);
  cacheTimes.set(key, Date.now());
  cacheBytes += bytes;
  while (cacheBytes > CACHE_MAX_BYTES || cache.size > 40) {
    const first = cache.keys().next().value as string;
    cacheBytes -= cacheSizes.get(first) || 0;
    cache.delete(first);
    cacheSizes.delete(first);
    cacheTimes.delete(first);
  }
}
function freshCached<T>(key: string): T | undefined {
  const storedAt = cacheTimes.get(key);
  if (!cache.has(key) || !storedAt) return undefined;
  if (Date.now() - storedAt > CACHE_TTL_MS) return undefined;
  return cache.get(key) as T;
}

export function invalidate(prefix = "") {
  const keys = new Set([...cache.keys(), ...inFlight.keys()]);
  for (const key of keys)
    if (key.startsWith(prefix)) {
      cache.delete(key);
      cacheBytes -= cacheSizes.get(key) || 0;
      cacheSizes.delete(key);
      cacheTimes.delete(key);
      const pending = inFlight.get(key);
      if (pending) pending.invalidated = true;
      inFlight.delete(key);
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
  retainWhenDisabled = false,
) {
  const key = `${method}:${JSON.stringify(payload)}`;
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const version = useRef(0);
  const running = useRef<{ key: string; version: number } | null>(null);
  const refresh = useCallback(
    async (force = true) => {
      if (!enabled) return;
      if (running.current?.key === key && !force) return;
      if (running.current?.key === key && force) {
        const pending = inFlight.get(key);
        if (pending) pending.invalidated = true;
        inFlight.delete(key);
      }
      const n = ++version.current;
      running.current = { key, version: n };
      setLoading(true);
      setError("");
      let request: PendingRequest | undefined;
      try {
        const cached = !force ? freshCached<T>(key) : undefined;
        if (cached !== undefined) {
          if (version.current === n) setData(cached);
          return;
        }
        request = inFlight.get(key);
        if (!request || request.invalidated) {
          request = {
            invalidated: false,
            promise: api<T>(method, {
              ...(JSON.parse(key.slice(method.length + 1)) as object),
              refresh: force,
            }),
          };
          inFlight.set(key, request);
        }
        const value = (await request.promise) as T;
        if (version.current === n && !request.invalidated) {
          cacheValue(key, value);
          setData(value);
        }
      } catch (e) {
        if (version.current === n && !request?.invalidated)
          setError(errorMessage(e));
      } finally {
        if (request && inFlight.get(key) === request) inFlight.delete(key);
        if (running.current?.version === n) running.current = null;
        if (version.current === n) setLoading(false);
      }
    },
    [key, method, enabled],
  );
  useEffect(() => {
    if (enabled) setData(cache.get(key) as T | undefined);
    else if (!retainWhenDisabled) setData(undefined);
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
