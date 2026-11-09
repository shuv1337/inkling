import { TOPIC, TAGS, type Book, type TagKey, type TopicKey } from "./library";

export const TABLE_COLUMNS = [
  { key: "title", label: "Title" },
  { key: "topic", label: "Topic" },
  { key: "minutes", label: "Length" },
  { key: "status", label: "Status" },
  { key: "added", label: "Added" },
  { key: "lastRead", label: "Last read" },
] as const;
export type TableColumn = (typeof TABLE_COLUMNS)[number]["key"];
export type TableSort = { key: TableColumn; direction: "asc" | "desc" };
export type ReadingStatus = "unread" | "reading" | "finished";
export const STATUS_LABELS: Record<ReadingStatus, string> = { unread: "Unread", reading: "In progress", finished: "Finished" };
export const DEFAULT_TABLE_SORT: TableSort = { key: "added", direction: "desc" };

export function validTableSort(value: unknown): TableSort {
  if (value && typeof value === "object" && "key" in value && "direction" in value &&
    TABLE_COLUMNS.some((c) => c.key === value.key) && (value.direction === "asc" || value.direction === "desc")) {
    return value as TableSort;
  }
  return DEFAULT_TABLE_SORT;
}

export function nextTableSort(current: TableSort, key: TableColumn): TableSort {
  return { key, direction: current.key === key ? (current.direction === "asc" ? "desc" : "asc") :
    key === "added" || key === "lastRead" ? "desc" : "asc" };
}

/** Completion is durable even if the reader later scrolls back up. */
export function readingStatus(book: Book): ReadingStatus {
  return book.finished || book.pct >= 1 ? "finished" : book.pct > 0 ? "reading" : "unread";
}

export function matchesLibraryBook(book: Book, query: string, tag: TagKey | null = null): boolean {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const text = `${book.title} ${book.author} ${book.source ?? ""} ${book.url ?? ""} ${TOPIC[book.topic].name} ${book.tags.join(" ")} ${book.year ?? ""}`.toLowerCase();
  return (!tag || TAGS.find((t) => t.key === tag)!.test(book)) && words.every((word) => text.includes(word));
}

export function filterTableBooks(books: Book[], status: ReadingStatus | "all", topic: TopicKey | "all"): Book[] {
  return books.filter((book) => (status === "all" || readingStatus(book) === status) && (topic === "all" || book.topic === topic));
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const statusOrder: Record<ReadingStatus, number> = { unread: 0, reading: 1, finished: 2 };

/** Unknown dates stay last in either direction; ties are deterministic. Never mutates the store. */
export function sortTableBooks(books: Book[], sort: TableSort): Book[] {
  return [...books].sort((a, b) => {
    let result = 0;
    if (sort.key === "title") result = collator.compare(a.title, b.title);
    else if (sort.key === "topic") result = collator.compare(TOPIC[a.topic].name, TOPIC[b.topic].name);
    else if (sort.key === "status") result = statusOrder[readingStatus(a)] - statusOrder[readingStatus(b)] || a.pct - b.pct;
    else if (sort.key === "minutes") result = a.minutes - b.minutes;
    else {
      const av = a[sort.key] || 0;
      const bv = b[sort.key] || 0;
      if (!av || !bv) return av ? -1 : bv ? 1 : collator.compare(a.title, b.title) || a.id.localeCompare(b.id);
      result = av - bv;
    }
    return result * (sort.direction === "asc" ? 1 : -1) || b.added - a.added || collator.compare(a.title, b.title) || a.id.localeCompare(b.id);
  });
}

export function bookSource(book: Book): string {
  if (book.url) {
    try { return new URL(book.url).hostname.replace(/^www\./, ""); } catch {}
  }
  return book.source || book.author || (book.sample ? "Sample text" : "Saved text");
}
