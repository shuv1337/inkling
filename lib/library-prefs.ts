"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_TABLE_SORT, validTableSort, type TableSort } from "./library-table";

/**
 * The library's own preferences, kept apart from the reading settings.
 * `hiddenSamples`: the bundled samples taken off this device's shelf.
 */
export type LibraryPrefs = { paintedCovers: boolean; hiddenSamples: string[]; view: "table" | "topics"; tableSort: TableSort };

const KEY = "gloss:library";
const DEFAULTS: LibraryPrefs = { paintedCovers: false, hiddenSamples: [], view: "table", tableSort: DEFAULT_TABLE_SORT };
const listeners = new Set<() => void>();
let cache: LibraryPrefs | null = null;

function read(): LibraryPrefs {
  if (cache) return cache;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    cache = { ...DEFAULTS, ...saved, view: saved?.view === "topics" ? "topics" : "table", tableSort: validTableSort(saved?.tableSort) };
  } catch {
    cache = DEFAULTS;
  }
  return cache!;
}

export function setLibraryPrefs(p: Partial<LibraryPrefs>) {
  cache = { ...read(), ...p };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {}
  listeners.forEach((l) => l());
}

/** Take a bundled sample off the shelf. It can still be opened by its link. */
export function hideSample(id: string) {
  const hidden = read().hiddenSamples;
  if (!hidden.includes(id)) setLibraryPrefs({ hiddenSamples: [...hidden, id] });
}

export function useLibraryPrefs(): LibraryPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => DEFAULTS
  );
}
