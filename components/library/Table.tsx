"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { TOPIC, TOPICS, type Book, type TopicKey } from "@/lib/library";
import { bookSource, filterTableBooks, nextTableSort, readingStatus, sortTableBooks, STATUS_LABELS, TABLE_COLUMNS, type ReadingStatus, type TableColumn, type TableSort } from "@/lib/library-table";

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
const fullDateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "short", timeZone: "America/Los_Angeles" });

function DateCell({ at, fallback = "Not yet" }: { at?: number; fallback?: string }) {
  return at ? <time dateTime={new Date(at).toISOString()} title={`${fullDateFormat.format(at)} (Pacific Time)`}>{dateFormat.format(at)}</time> : <span>{fallback}</span>;
}

export function LibraryTable({ books, sort, onSort, onClearSearch, searching }: {
  books: Book[];
  sort: TableSort;
  onSort: (sort: TableSort) => void;
  onClearSearch: () => void;
  searching: boolean;
}) {
  const [status, setStatus] = useState<ReadingStatus | "all">("all");
  const [topic, setTopic] = useState<TopicKey | "all">("all");
  const rows = useMemo(() => sortTableBooks(filterTableBooks(books, status, topic), sort), [books, sort, status, topic]);
  const activeFilters = searching || status !== "all" || topic !== "all";
  const sortBy = (key: TableColumn) => onSort(nextTableSort(sort, key));
  const Direction = sort.direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <section className="lib-table-view" aria-label="Library table">
      <div className="lib-table-filters" role="group" aria-label="Reading status">
        {(["all", "unread", "reading", "finished"] as const).map((key) => (
          <button key={key} type="button" className="lib-chip" aria-pressed={status === key} onClick={() => setStatus(key)}>
            {key === "all" ? "All" : STATUS_LABELS[key]}
          </button>
        ))}
      </div>
      <div className="lib-table-toolbar">
        <label className="lib-table-topic">
          <span className="sr-only">Filter by topic</span>
          <select value={topic} onChange={(e) => setTopic(e.target.value as TopicKey | "all")}>
            <option value="all">All topics</option>
            {TOPICS.filter((t) => t.key === topic || books.some((b) => b.topic === t.key)).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
          </select>
        </label>
        <div className="lib-table-mobile-sort">
          <label>
            <span className="sr-only">Sort by</span>
            <select aria-label="Sort by" value={sort.key} onChange={(e) => sortBy(e.target.value as TableColumn)}>
              {TABLE_COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => sortBy(sort.key)} aria-label={`Sort ${sort.direction === "asc" ? "descending" : "ascending"}`} title={sort.direction === "asc" ? "Ascending" : "Descending"}>
            <Direction size={16} aria-hidden />
          </button>
        </div>
        <p className="lib-table-count" role="status">{rows.length} {rows.length === 1 ? "text" : "texts"}{activeFilters ? " match" : ""}</p>
        {activeFilters && <button className="lib-table-reset" type="button" onClick={() => { setStatus("all"); setTopic("all"); onClearSearch(); }}>Clear filters</button>}
      </div>
      <table className="lib-table" role="table" data-sort={sort.key}>
        <caption className="sr-only">Saved texts, sorted by {TABLE_COLUMNS.find((c) => c.key === sort.key)?.label}, {sort.direction === "asc" ? "ascending" : "descending"}</caption>
        <thead role="rowgroup">
          <tr role="row">
            {TABLE_COLUMNS.map((c) => (
              <th key={c.key} scope="col" role="columnheader" aria-label={c.label} aria-sort={sort.key === c.key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                <button type="button" onClick={() => sortBy(c.key)}>{c.label}{sort.key === c.key ? <Direction size={14} aria-hidden /> : <ArrowUpDown size={13} aria-hidden className="lib-table-sort-idle" />}</button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((book) => {
            const state = readingStatus(book);
            const pct = state === "finished" ? 100 : Math.min(99, Math.max(1, Math.round(book.pct * 100)));
            return (
              <tr key={book.id} role="row">
                <td className="lib-table-title" role="cell">
                  <Link href={`/read/${book.id}`} prefetch={false}>{book.title}</Link>
                  <span className="lib-table-source">{bookSource(book)}{book.sample && " · Sample"}</span>
                </td>
                <td className="lib-table-topic-cell" role="cell">{TOPIC[book.topic].name}</td>
                <td className="lib-table-added" role="cell"><span className="lib-table-mobile-label">Added </span><DateCell at={book.added} fallback={book.sample ? "Sample" : "Unknown"} /></td>
                <td className="lib-table-length" role="cell">{book.minutes} min<span className="lib-table-mobile-label"> read</span></td>
                <td className="lib-table-status" role="cell">
                  <span>{STATUS_LABELS[state]}{state === "reading" && <span className="lib-table-pct"> {pct}%</span>}</span>
                  {state !== "unread" && <span className="lib-table-progress" aria-hidden><span style={{ width: `${pct}%` }} /></span>}
                </td>
                <td className="lib-table-last" role="cell"><span className="lib-table-mobile-label">Last read </span><DateCell at={book.lastRead} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && <div className="lib-table-empty"><h2>{activeFilters ? "No matching texts" : "Your next read starts here"}</h2><p>{activeFilters ? "Try another search, or clear the filters to see everything." : "Add an article, a link or a PDF to start your library."}</p></div>}
    </section>
  );
}
