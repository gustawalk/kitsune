import { clsx, type ClassValue } from "clsx";
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export const modKey =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform)
    ? "⌘"
    : "Ctrl";
