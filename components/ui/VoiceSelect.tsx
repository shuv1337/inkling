"use client";

import { useEffect, useState } from "react";
import { loadTtsPublic, saveVoice, savedVoice, type TtsPublic } from "@/lib/tts-client";

/** Shown when the server lists more than one voice. The choice stays in this browser. */
export function VoiceSelect() {
  const [cfg, setCfg] = useState<TtsPublic | null>(null);
  const [voice, setVoice] = useState("");

  useEffect(() => {
    void loadTtsPublic().then((c) => {
      setCfg(c);
      const saved = savedVoice();
      setVoice(saved && c.voices.some((v) => v.id === saved) ? saved : c.voice);
    });
  }, []);

  if (!cfg?.enabled || cfg.voices.length < 2) return null;
  return (
    <label className="flex items-center justify-between gap-3 border-t border-rule pt-3 text-[13px]">
      <span className="text-ink-3">Voice</span>
      <select
        value={voice}
        aria-label="Reading voice"
        onChange={(e) => {
          setVoice(e.target.value);
          saveVoice(e.target.value);
        }}
        className="h-8 max-w-[11rem] rounded-lg border border-rule bg-bg px-2 text-[13px] text-ink"
      >
        {cfg.voices.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
      </select>
    </label>
  );
}
