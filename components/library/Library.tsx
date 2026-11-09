"use client";

import { useAccount } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, ViewTransition } from "react";
import { ChevronLeft, LayoutGrid, Table2, Search, X } from "lucide-react";
import { TopBar } from "@/components/ui/TopBar";
import { readingMinutes, tidyTitle, wordCount } from "@/lib/article";
import { forgetCover, paintAll } from "@/lib/covers";
import { SAMPLE_SHELF } from "@/lib/classics";
import { TAGS, TOPIC, TOPICS, topicOf, type Book, type TagKey, type Topic, type TopicKey } from "@/lib/library";
import { hideSample, setLibraryPrefs, useLibraryPrefs } from "@/lib/library-prefs";
import { SAMPLES } from "@/lib/samples";
import { applySettings } from "@/lib/settings";
import { backfill } from "@/lib/shelving";
import { useStore } from "@/lib/store";
import { watchShelf } from "@/lib/sync";
import { AddButton, AddPanel, type AddTab } from "./AddPanel";
import { Arrivals, type Wave } from "./Arrivals";
import { Glyph } from "./Book";
import { BookOpen, type Origin } from "./BookOpen";
import { LibraryTable } from "./Table";
import { matchesLibraryBook, readingStatus } from "@/lib/library-table";
import { Starter } from "./Starter";
import { TopicGrid, TopicPage } from "./Topics";

type View = "table" | "topics";

const SEEN_KEY = "gloss:library-seen";
/** Samples stay on the shelf until it has this many texts of your own, or for good once opened, unless taken off. */
const SAMPLES_UNTIL = 6;

/** A searchable reading list, with illustrated topics for browsing. */
export function Library() {
  const router = useRouter();
  const { signedIn: isSignedIn, firstName, name } = useAccount();
  const hydrate = useStore((s) => s.hydrate);
  const hydrated = useStore((s) => s.hydrated);
  const library = useStore((s) => s.library);
  const progress = useStore((s) => s.progress);
  const highlights = useStore((s) => s.highlights);
  const shelveItem = useStore((s) => s.shelve);
  const removeFromLibrary = useStore((s) => s.removeFromLibrary);
  const prefs = useLibraryPrefs();

  const view = prefs.view;
  const [topic, setTopic] = useState<TopicKey | null>(null);
  const [tag, setTag] = useState<TagKey | null>(null);
  const [q, setQ] = useState("");
  const [tableReset, setTableReset] = useState(0);
  const [open, setOpen] = useState<{ id: string; origin: Origin } | null>(null);
  const [adding, setAdding] = useState<AddTab | null>(null);
  const [leaving, setLeaving] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const known = useRef<Set<string> | null>(null);
  const [lastSeen, setLastSeen] = useState(0);

  useEffect(() => {
    hydrate();
    applySettings(useStore.getState().settings);
    try {
      setLastSeen(Number(localStorage.getItem(SEEN_KEY)) || 0);
      localStorage.setItem(SEEN_KEY, String(Date.now()));
    } catch {}
  }, [hydrate]);

  const [wave, setWave] = useState<Wave | null>(null);
  const waveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closeWave = useCallback(() => {
    clearTimeout(waveTimer.current);
    setWave((w) => w && { ...w, leaving: true });
    waveTimer.current = setTimeout(() => setWave(null), 240);
  }, []);
  useEffect(() => () => clearTimeout(waveTimer.current), []);

  // Signed in, the shelf is checked every few seconds while it's open, so an agent's saves arrive as you look.
  useEffect(() => watchShelf(), []);

  // The top bar frosts over once the page moves under it.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 2);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  // Anything that lands on the shelf while you look (an import, a sync from your agent) drops in.
  useEffect(() => {
    if (!hydrated) return;
    const ids = new Set(library.map((x) => x.id));
    if (!known.current) {
      known.current = ids;
      return;
    }
    const added = [...ids].filter((id) => !known.current!.has(id));
    known.current = ids;
    if (!added.length) return;

    // And they gather on the arrivals card: one card per run, kept open while more keep coming.
    const items = library.filter((x) => added.includes(x.id) && x.origin !== "sample");
    if (!items.length) return;
    const byAgent = items.find((x) => x.addedBy === "agent");
    setWave((w) => {
      const cur = w && !w.done && !w.leaving ? w : null;
      return { ids: [...(cur?.ids ?? []), ...items.map((x) => x.id)], agent: Boolean(cur?.agent || byAgent), via: cur?.via ?? byAgent?.addedVia, done: false };
    });
    // An agent's saves come in batches a few seconds apart; the run is over once it goes quiet.
    clearTimeout(waveTimer.current);
    waveTimer.current = setTimeout(() => {
      setWave((w) => w && { ...w, done: true });
      waveTimer.current = setTimeout(closeWave, 9000);
    }, byAgent ? 14_000 : 6000);
  }, [hydrated, library, closeWave]);

  // Texts shelved before the library existed are sorted onto topics the first time it opens.
  useEffect(() => {
    if (hydrated) void backfill(useStore.getState().library);
  }, [hydrated, library.length]);

  // Painted covers, when they're turned on: one at a time, for every sorted text without one.
  useEffect(() => {
    if (hydrated && prefs.paintedCovers) void paintAll(useStore.getState().library);
  }, [hydrated, prefs.paintedCovers, library]);

  const own = library.filter((x) => x.origin !== "sample");
  const books = useMemo(() => {
    const read = (id: string) => (hydrated ? progress[id]?.pct ?? 0 : 0);
    const marks = (id: string) => (hydrated ? (highlights[id] ?? []).length : 0);
    const mine: Book[] = library.map((x) => ({
      id: x.id,
      title: tidyTitle(x.title),
      author: bylineOf(x),
      year: x.year,
      url: x.sourceUrl,
      source: x.source,
      lastRead: hydrated ? progress[x.id]?.at : undefined,
      topic: topicOf(x.topic),
      minutes: readingMinutes(x.words),
      dek: x.dek,
      tags: x.tags ?? [],
      favorite: Boolean(x.favorite),
      pct: read(x.id),
      highlights: marks(x.id),
      added: x.addedAt,
      finished: x.finishedAt,
      image: x.image,
      cover: x.cover,
      agent: x.addedBy === "agent",
      sample: false,
    }));
    const samples: Book[] = SAMPLES.filter((a) => !prefs.hiddenSamples.includes(a.id) && (own.length < SAMPLES_UNTIL || read(a.id) > 0)).map((a) => ({
      id: a.id,
      title: a.title,
      author: a.author ?? "",
      year: Number(a.published?.match(/\d{4}/)?.[0]) || undefined,
      topic: SAMPLE_SHELF[a.id]?.topic ?? "unsorted",
      minutes: readingMinutes(wordCount(a)),
      dek: a.dek,
      tags: [],
      favorite: false,
      pct: read(a.id),
      highlights: marks(a.id),
      added: 0,
      lastRead: hydrated ? progress[a.id]?.at : undefined,
      cover: SAMPLE_SHELF[a.id]?.cover,
      agent: false,
      sample: true,
    }));
    return [...mine, ...samples];
    // `own.length` is derived from `library`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, progress, highlights, hydrated, prefs.hiddenSamples]);

  const match = useCallback((b: Book) => matchesLibraryBook(b, q, tag), [q, tag]);
  const matchingBooks = useMemo(() => books.filter(match), [books, match]);

  const topics = useMemo(
    () => TOPICS.map((t) => ({ topic: t, books: books.filter((b) => b.topic === t.key).sort((a, b) => b.added - a.added) })).filter((x) => x.books.length),
    [books]
  );

  const stats = useMemo(() => {
    const mins = books.reduce((n, b) => n + b.minutes, 0);
    return {
      count: books.length,
      topics: topics.filter((t) => t.topic.key !== "unsorted").length,
      hours: Math.max(1, Math.round(mins / 60)),
      reading: books.filter((b) => readingStatus(b) === "reading").length,
      read: books.filter((b) => readingStatus(b) === "finished").length,
    };
  }, [books, topics]);

  const fromAgent = useMemo(() => (lastSeen ? books.filter((b) => b.agent && b.added > lastSeen) : []), [books, lastSeen]);

  const go = useCallback((to: { view: View; topic?: TopicKey | null }) => {
    startTransition(() => {
      setLibraryPrefs({ view: to.view });
      setTopic(to.topic ?? null);
      setTag(null);
    });
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  // "/" to search, wherever you are; Esc steps back out of a topic.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open || adding || e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest?.("input, textarea, select, [contenteditable]")) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && topic) go({ view: "topics" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, adding, topic, go]);

  const read = useCallback(
    (b: Book) => {
      setLeaving(true);
      router.push(`/read/${b.id}`);
    },
    [router]
  );

  const openBook = open ? books.find((b) => b.id === open.id) ?? null : null;
  const first = firstName;
  const owner = name || first || "An Inkling reader";
  const T = topic ? TOPIC[topic] : null;
  const topicBooks = useMemo(() => (topic ? books.filter((b) => b.topic === topic).sort((a, b) => b.added - a.added).filter(match) : []), [topic, books, match]);
  const screen = topic ? `topic-${topic}` : view;

  const searchBox = (
    <label className="lib-search">
      <Search size={15} className="shrink-0 text-ink-4" aria-hidden />
      <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={T ? `Search ${T.name}` : "Search the library"} aria-label="Search the library" />
      {q ? (
        <button type="button" aria-label="Clear search" onClick={() => setQ("")} className="grid size-5 place-items-center rounded-full text-ink-3 hover:bg-sunk">
          <X size={13} />
        </button>
      ) : (
        <kbd className="max-sm:hidden">/</kbd>
      )}
    </label>
  );

  const tagChips = (pool: Book[]) =>
    TAGS.map((t) => {
      const n = pool.filter(t.test).length;
      if (!n) return null;
      return (
        <Chip key={t.key} on={tag === t.key} onClick={() => setTag(tag === t.key ? null : t.key)}>
          <Glyph k={t.key} size={18} /> {t.label} <span className="lib-n">{n}</span>
        </Chip>
      );
    });

  return (
    <div data-view={view} className={`library relative z-[1] min-h-dvh transition-[opacity,filter] duration-300 ${leaving ? "opacity-0 blur-[2px]" : ""}`}>
      <div className="lib-top" data-scrolled={scrolled || undefined}>
        <TopBar here="library" onLibrary={() => go({ view: topic ? "topics" : view })} />
      </div>

      <main className="mx-auto w-full max-w-[1180px] px-4 pb-32 sm:px-8">
        {!T && (
          <section className="lib-hero">
            <div className="lib-hero-row">
              <div className="min-w-0">
                <h1 className="lib-title">{first ? `${first}'s library` : "Your library"}</h1>
                {/* Its height is kept while the shelf is read, so the tools below never jump. */}
                <p className="lib-stats">
                  {hydrated && (
                    <>
                      <span>
                        <b>{stats.count}</b> {stats.count === 1 ? "text" : "texts"}
                      </span>
                      {view === "topics" && stats.topics > 0 && (
                        <span>
                          <b>{stats.topics}</b> {stats.topics === 1 ? "topic" : "topics"}
                        </span>
                      )}
                      {view === "topics" && <span>
                        <b>{stats.hours}</b> {stats.hours === 1 ? "hour" : "hours"} of reading
                      </span>}
                      {stats.reading > 0 && (
                        <span>
                          <b>{stats.reading}</b> in progress
                        </span>
                      )}
                      {stats.read > 0 && (
                        <span>
                          <b>{stats.read}</b> read
                        </span>
                      )}
                    </>
                  )}
                </p>
              </div>
              <AddButton onClick={() => setAdding("agent")} />
            </div>
            {fromAgent.length > 0 && (
              <button type="button" className="lib-news" onClick={() => { go({ view: "table" }); setQ(""); setTableReset((key) => key + 1); setTag("agent"); }}>
                <Glyph k="agent" size={22} />
                {fromAgent.length} new from your agent since you last looked
              </button>
            )}
          </section>
        )}

        {T ? (
          <div className="lib-tools is-topic">
            <button type="button" onClick={() => go({ view: "topics" })} className="lib-back">
              <ChevronLeft size={16} /> All topics
            </button>
            <AddButton compact onClick={() => setAdding("agent")} />
          </div>
        ) : (
          <div className="lib-tools">
            <ViewSwitch view={view} onChange={(v) => go({ view: v })} />
            {searchBox}
          </div>
        )}

        <ViewTransition key={screen} enter="lib-enter" exit="lib-exit" default="none">
          <div className="lib-screen">
            {T ? (
              <TopicPage
                topic={T}
                books={topicBooks}
                tools={
                  <div className="lib-tools mt-8">
                    {searchBox}
                    <div className="lib-chips no-scrollbar">{tagChips(books.filter((b) => b.topic === T.key))}</div>
                  </div>
                }
                onOpen={(b, el) => setOpen({ id: b.id, origin: { el, kind: "cover" } })}
              />
            ) : view === "table" ? (
              <>
                {hydrated ? (
                  <LibraryTable key={tableReset} tag={tag} onClearTag={() => setTag(null)} books={matchingBooks} sort={prefs.tableSort} onSort={(tableSort) => setLibraryPrefs({ tableSort })} searching={Boolean(q.trim() || tag)} onClearSearch={() => { setQ(""); setTag(null); }} />
                ) : <p className="py-10 text-ink-3" role="status">Loading your library…</p>}
                {hydrated && own.length < SAMPLES_UNTIL && <Starter count={own.length} signedIn={Boolean(isSignedIn)} onAdd={setAdding} />}
              </>
            ) : (
              <TopicGrid topics={topics.map((t) => ({ ...t, books: t.books.filter(match) })).filter((t) => t.books.length)} onPick={(t: Topic) => go({ view: "topics", topic: t.key })} />
            )}
          </div>
        </ViewTransition>
      </main>

      {open && openBook && (
        <BookOpen
          key={open.id}
          book={openBook}
          origin={open.origin}
          owner={owner}
          onRead={read}
          onShelve={(b, patch) => shelveItem(b.id, patch)}
          onRemove={(b) => {
            setOpen(null);
            if (b.sample) return hideSample(b.id);
            removeFromLibrary(b.id);
            void forgetCover(b.id);
          }}
          onClose={() => {
            const id = open.id;
            setOpen(null);
            requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-book="${id}"]`)?.focus({ preventScroll: true }));
          }}
        />
      )}

      {wave && (
        <Arrivals
          wave={wave}
          books={wave.ids.flatMap((id) => books.find((b) => b.id === id) ?? [])}
          onClose={closeWave}
          onShow={() => {
            closeWave();
            setAdding(null);
            setTag(null);
            setQ("");
            setTableReset((key) => key + 1);
            go({ view: "table" });
          }}
          onRemove={() => {
            closeWave();
            if (open && wave.ids.includes(open.id)) setOpen(null);
            for (const id of wave.ids) {
              removeFromLibrary(id);
              void forgetCover(id);
            }
          }}
        />
      )}
      {adding && <AddPanel tab={adding} onTab={setAdding} onClose={() => setAdding(null)} signedIn={Boolean(isSignedIn)} />}
    </div>
  );
}

/** Who wrote it, or failing that where it is from: a site's name without its domain ending, a file without its extension. */
function bylineOf(x: { author?: string; source?: string; origin?: string }): string {
  if (x.author) return x.author;
  const src = x.source?.split(",")[0].trim();
  if (src) return src.replace(/^www\./, "").replace(/\.(pdf|txt|md|markdown)$/i, "").replace(/\.(com|org|net|io|ai|dev|co|edu|blog|app)(\.[a-z]{2})?$/i, "");
  return x.origin === "paste" ? "Pasted text" : x.origin === "file" ? "A file" : "Saved";
}

function Chip({ on, color, onClick, children }: { on: boolean; color?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className="lib-chip" style={color ? { ["--c" as string]: color } : undefined}>
      {children}
    </button>
  );
}

function ViewSwitch({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div className="lib-switch" role="radiogroup" aria-label="View" data-view={view}>
      <span className="lib-switch-pill" aria-hidden />
      <button type="button" role="radio" aria-checked={view === "table"} onClick={() => onChange("table")}>
        <Table2 size={15} /> Table
      </button>
      <button type="button" role="radio" aria-checked={view === "topics"} onClick={() => onChange("topics")}>
        <LayoutGrid size={15} /> Topics
      </button>
    </div>
  );
}
