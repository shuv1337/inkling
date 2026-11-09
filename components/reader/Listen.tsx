"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Headphones, LoaderCircle, Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import { blockEl } from "@/lib/anchor";
import { blockText } from "@/lib/article";
import { openKeyMenu, readApiKey } from "@/lib/ask";
import type { DocIndex } from "@/lib/doc";
import { useStore } from "@/lib/store";
import { loadTtsPublic, savedVoice, type TtsPublic } from "@/lib/tts-client";
import { adjacentUnit, briefUnits, passageChunks, spokenBlocks, type SpokenUnit } from "@/lib/voice";
import type { BriefData } from "@/lib/article";
import { barBtn } from "@/components/ui/Popover";
import { useReader } from "./context";

/**
 * Read aloud. The text is spoken a passage at a time from where you are, each
 * clip fetched a little ahead of the voice, and the paragraph being read is
 * marked like the keyboard cursor so the eye can follow along.
 */

type Status = "idle" | "loading" | "playing" | "paused" | "error";
/** What is being read: the text itself, or the brief above it. */
type Source = "text" | "brief";
type ListenState = { status: Status; source: Source; block: string | null; rate: number; error?: string; needKey?: boolean };

const RATES = [1, 1.2, 1.4, 1.7, 2, 0.8];
const RATE_KEY = "gloss:listen-rate";

const useListen = create<ListenState>(() => ({ status: "idle", source: "text", block: null, rate: 1 }));

/** The brief passage being read, so the brief can mark it. */
export const useListenBriefItem = () => useListen((s) => (s.source === "brief" ? s.block : null));


let ttsConfig: TtsPublic | null = null;

/** A few hundred milliseconds of silence, played inside the click so phones let the voice play later. */
function silence(): string {
  const n = 800;
  const b = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  b.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, 1, true);
  b.setUint32(24, 8000, true);
  b.setUint32(28, 16000, true);
  b.setUint16(32, 2, true);
  b.setUint16(34, 16, true);
  str(36, "data");
  b.setUint32(40, n * 2, true);
  let bin = "";
  new Uint8Array(b.buffer).forEach((x) => (bin += String.fromCharCode(x)));
  return `data:audio/wav;base64,${btoa(bin)}`;
}

/* ---------------- the engine: one voice at a time ---------------- */

let units: SpokenUnit[] = [];
let items: { block: string; text: string }[] = [];
let idx = 0;
let session = 0;
let audio: HTMLAudioElement | null = null;
let ctrl: AbortController | null = null;
const clips = new Map<number, Promise<string>>();
const urls = new Map<number, string>();

function clip(i: number): Promise<string> {
  let p = clips.get(i);
  if (!p) {
    const signal = ctrl?.signal;
    p = fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: items[i].text, apiKey: readApiKey() || undefined, voice: savedVoice() }),
      signal,
    }).then(async (r) => {
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string; code?: string };
        if (j.code === "need_key") useListen.setState({ needKey: true });
        throw new Error(j.error ?? "The voice did not answer.");
      }
      const url = URL.createObjectURL(await r.blob());
      urls.set(i, url);
      return url;
    });
    // A failed clip is forgotten, so "Try again" fetches it afresh.
    p.catch(() => clips.get(i) === p && clips.delete(i));
    clips.set(i, p);
  }
  return p;
}

function release(upTo: number) {
  for (const [i, url] of urls) {
    if (i < upTo) {
      URL.revokeObjectURL(url);
      urls.delete(i);
      clips.delete(i);
    }
  }
}

async function playAt(i: number, s: number) {
  if (s !== session || !audio) return;
  if (i >= items.length) return stopListening();
  idx = i;
  const ready = urls.has(i);
  useListen.setState({ block: items[i].block, ...(ready ? {} : { status: "loading" }) });
  let url: string;
  try {
    url = await clip(i);
  } catch (e) {
    if (s === session) useListen.setState({ status: "error", error: e instanceof Error ? e.message : "The voice did not answer." });
    return;
  }
  if (s !== session || !audio) return;
  void clip(i + 1 < items.length ? i + 1 : i);
  if (i + 2 < items.length) void clip(i + 2);
  release(i - 1);
  audio.src = url;
  audio.playbackRate = useListen.getState().rate;
  try {
    await audio.play();
    if (s === session) useListen.setState({ status: "playing" });
  } catch {
    if (s === session) useListen.setState({ status: "paused" });
  }
}

export function startListening(ix: DocIndex, fromBlock: string | null) {
  const units = spokenBlocks(ix.article.blocks).map((b) => ({ id: b.id, text: blockText(b).trim() }));
  const at = fromBlock ? ix.article.blocks.findIndex((b) => b.id === fromBlock) : -1;
  // From a block that is not spoken itself (an image, say), start at the next one that is.
  const from = at < 0 ? null : spokenBlocks(ix.article.blocks.slice(at))[0]?.id ?? null;
  play(ix, "text", units, from);
}

/** Read the brief aloud, from the gist or from one of its passages. */
export function startListeningBrief(ix: DocIndex, data: BriefData, from: string | null = null) {
  play(ix, "brief", briefUnits(data), from);
}

function play(ix: DocIndex, source: Source, all: SpokenUnit[], from: string | null) {
  stopListening();
  if (ttsConfig && !ttsConfig.enabled) {
    useListen.setState({ status: "error", error: ttsConfig.reason || "Reading aloud is turned off." });
    return;
  }
  // Together with no server key still needs the reader's own key. An OpenAI-compatible server may not.
  if (ttsConfig?.needsKey && !readApiKey()) {
    useListen.setState({ status: "error", needKey: true, error: "Reading aloud needs an API key." });
    return;
  }
  const at = Math.max(0, from ? all.findIndex((u) => u.id === from) : 0);
  units = all;
  items = [];
  for (const u of all.slice(at)) {
    if (!u.text) continue;
    for (const c of passageChunks(u.text, !items.length)) items.push({ block: u.id, text: c });
  }
  if (!items.length) return;
  useListen.setState({ source });

  audio ??= new Audio();
  // Only a spoken clip ending moves on; the unlocking silence ending must not.
  audio.onended = () => audio?.src.startsWith("blob:") && void playAt(idx + 1, session);
  // Unlock playback inside the click: later clips arrive after an await.
  audio.src = silence();
  audio.play().catch(() => {});

  ctrl = new AbortController();
  const s = ++session;
  try {
    const r = Number(localStorage.getItem(RATE_KEY));
    if (RATES.includes(r)) useListen.setState({ rate: r });
  } catch {}
  if ("mediaSession" in navigator) {
    const title = source === "brief" ? `Brief: ${ix.article.title}` : ix.article.title;
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist: ix.article.author ?? ix.article.source ?? "Inkling" });
    navigator.mediaSession.setActionHandler("play", () => toggleListening());
    navigator.mediaSession.setActionHandler("pause", () => toggleListening());
  }
  void playAt(0, s);
}

/** Move to another passage of whatever is being read. */
function skipTo(ix: DocIndex, id: string) {
  play(ix, useListen.getState().source, units, id);
}

export function stopListening() {
  session++;
  ctrl?.abort();
  ctrl = null;
  if (audio) {
    audio.onended = null;
    audio.pause();
    audio.removeAttribute("src");
  }
  release(Infinity);
  clips.clear();
  items = [];
  units = [];
  useListen.setState({ status: "idle", source: "text", block: null, error: undefined, needKey: false });
}

function toggleListening() {
  const { status } = useListen.getState();
  if (!audio) return;
  if (status === "playing") {
    audio.pause();
    useListen.setState({ status: "paused" });
  } else if (status === "paused") {
    audio.play().then(() => useListen.setState({ status: "playing" })).catch(() => {});
  } else if (status === "error") {
    useListen.setState({ error: undefined });
    void playAt(idx, session);
  }
}

function cycleRate() {
  const { rate } = useListen.getState();
  const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
  useListen.setState({ rate: next });
  if (audio) audio.playbackRate = next;
  try {
    localStorage.setItem(RATE_KEY, String(next));
  } catch {}
}

/* ---------------- the controls ---------------- */

/** A brief passage on the page, marked with data-listen. */
const briefItemEl = (id: string) => document.querySelector<HTMLElement>(`[data-listen="${CSS.escape(id)}"]`);

/** Listen is on in settings and the server can speak. */
function useListenAvailable(): boolean {
  const on = useStore((s) => s.settings.listen);
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    if (!on) return;
    void loadTtsPublic().then((cfg) => {
      ttsConfig = cfg;
      setEnabled(cfg.enabled);
    });
  }, [on]);
  return on && enabled;
}

/** In the brief's header: reads the gist, the claims and the caveats. */
export function BriefListenButton({ data, onStart }: { data: BriefData; onStart?: () => void }) {
  const { ix } = useReader();
  const reading = useListen((s) => s.status !== "idle" && s.source === "brief");
  if (!useListenAvailable()) return null;
  const label = reading ? "Stop reading the brief" : "Read the brief aloud";
  return (
    <button
      type="button"
      onClick={() => {
        if (reading) return stopListening();
        onStart?.();
        startListeningBrief(ix, data);
      }}
      aria-label={label}
      aria-pressed={reading}
      title={label}
      className={`grid size-8 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-sunk hover:text-ink ${reading ? "bg-sunk text-ink" : ""}`}
    >
      <Headphones size={15} strokeWidth={1.8} aria-hidden />
    </button>
  );
}

/** In the top bar, only when Listen is on in settings. Starts from the paragraph you are on. */
export function ListenButton({ from }: { from: () => string | null }) {
  const { ix } = useReader();
  const status = useListen((s) => s.status);
  if (!useListenAvailable()) return null;
  const active = status !== "idle";
  return (
    <button
      type="button"
      className={`${barBtn} ${active ? "bg-sunk text-ink" : ""}`}
      aria-label={active ? "Stop reading aloud" : "Read aloud from here"}
      aria-pressed={active}
      data-tip={active ? "Stop reading aloud" : "Read aloud from here"}
      onClick={() => {
        if (active) return stopListening();
        // The paragraph cursor when it is on screen, otherwise the first paragraph in view.
        const cursor = useStore.getState().cursor;
        const r = cursor ? blockEl(cursor)?.getBoundingClientRect() : null;
        startListening(ix, r && r.bottom > 0 && r.top < window.innerHeight ? cursor : from());
      }}
    >
      <Headphones size={16} strokeWidth={1.8} />
    </button>
  );
}

/** While the voice is reading: a small bar just above the question box, and the cursor on the paragraph being read. */
export function ListenBar() {
  const { ix, jumpToBlock } = useReader();
  const { status, source, block, rate, error, needKey } = useListen();
  const on = useStore((s) => s.settings.listen);
  const setUI = useStore((s) => s.setUI);
  const prev = useRef<string | null>(null);

  // Leaving the text, or switching Listen off, stops the voice.
  useEffect(() => () => stopListening(), [ix]);
  useEffect(() => {
    if (!on) stopListening();
  }, [on]);

  const show = useCallback(
    (id: string) => (source === "brief" ? briefItemEl(id)?.scrollIntoView({ block: "center", behavior: "smooth" }) : jumpToBlock(id, { flash: false })),
    [source, jumpToBlock],
  );

  // Follow the voice, but only while the reader is following too.
  useEffect(() => {
    if (!block) {
      prev.current = null;
      return;
    }
    const el = (id: string) => (source === "brief" ? briefItemEl(id) : blockEl(id));
    if (source === "text") setUI({ cursor: block });
    const was = prev.current ? el(prev.current)?.getBoundingClientRect() : null;
    const following = !was || (was.bottom > 0 && was.top < window.innerHeight);
    const r = el(block)?.getBoundingClientRect();
    if (following && r && (r.top < 80 || r.bottom > window.innerHeight * 0.8)) show(block);
    prev.current = block;
  }, [block, source, show, setUI]);

  if (status === "idle") return null;
  const n = block && source === "text" ? ix.numbers.get(block) : undefined;
  const previous = adjacentUnit(units, block, -1);
  const next = adjacentUnit(units, block, 1);
  const label = source === "brief" ? "Reading brief" : n ? `Reading ¶${n}` : "Reading";

  return (
    <div
      role="region"
      aria-label="Reading aloud"
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+80px)] left-1/2 sm:bottom-[calc(env(safe-area-inset-bottom)+90px)] z-[46] flex -translate-x-1/2 items-center gap-1 rounded-full bg-lens p-1 text-lens-fg shadow-pop ring-1 ring-black/5"
      style={{ animation: "rise 0.35s var(--ease-out) both" }}
    >
      {!needKey && (
        <button
          type="button"
          onClick={toggleListening}
          aria-label={status === "playing" ? "Pause" : status === "error" ? "Try again" : "Play"}
          className="grid size-9 place-items-center rounded-full bg-[var(--rubric)] text-white transition-transform active:scale-90"
        >
          {status === "loading" ? (
            <LoaderCircle size={16} className="animate-spin" />
          ) : status === "playing" ? (
            <Pause size={15} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={15} fill="currentColor" strokeWidth={0} className="translate-x-px" />
          )}
        </button>
      )}
      {status !== "error" && (
        <>
          {([{ target: previous, label: "Previous paragraph", Icon: SkipBack }, { target: next, label: "Next paragraph", Icon: SkipForward }]).map(({ target, label, Icon }) => (
            <button key={label} type="button" aria-label={label} title={label} disabled={!target}
              onClick={() => target && skipTo(ix, target)}
              className="grid size-9 shrink-0 place-items-center rounded-full hover:bg-lens-hover disabled:opacity-30 disabled:cursor-not-allowed">
              <Icon size={16} aria-hidden />
            </button>
          ))}
        </>
      )}
      {status === "error" ? (
        <>
          <span className={`max-w-[min(360px,60vw)] truncate px-2 text-[13px] ${needKey ? "pl-3.5" : ""}`} title={error}>
            {error}
          </span>
          {needKey && (
            <button
              type="button"
              onClick={() => {
                stopListening();
                openKeyMenu();
              }}
              className="h-9 shrink-0 rounded-full px-3 text-[13px] font-medium underline decoration-lens-mute underline-offset-4 transition-colors hover:bg-lens-hover"
            >
              Add key
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          onClick={() => block && show(block)}
          className="h-9 rounded-full px-2.5 text-[13px] tabular-nums text-lens-fg/85 transition-colors hover:bg-lens-hover hover:text-lens-fg"
          aria-label={source === "brief" ? "Reading the brief. Show where." : n ? `Reading paragraph ${n}. Show it.` : "Show where it is reading"}
        >
          {label}
        </button>
      )}
      {!needKey && (
        <button
          type="button"
          onClick={cycleRate}
          aria-label={`Speed ${rate} times. Change speed.`}
          className="h-9 min-w-[48px] rounded-full px-2.5 text-[13px] font-medium tabular-nums transition-colors hover:bg-lens-hover"
        >
          {`${rate}×`}
        </button>
      )}
      <button type="button" onClick={stopListening} aria-label="Stop reading aloud" className="grid size-9 place-items-center rounded-full text-lens-fg/80 transition-colors hover:bg-lens-hover hover:text-lens-fg">
        <Square size={13} fill="currentColor" strokeWidth={0} />
      </button>
    </div>
  );
}
