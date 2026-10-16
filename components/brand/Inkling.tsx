import Link from "next/link";

/** Lines of text with a note in the margin: the whole idea in 24px. */
export function InklingMark({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <path d="M3 6.5h10.5M3 11.5h10.5M3 16.5h6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M18.5 3v18" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" opacity="0.32" />
      <path d="M18.5 7.4c0 0-2.9 3.1-2.9 5.2a2.9 2.9 0 0 0 5.8 0c0-2.1-2.9-5.2-2.9-5.2Z" fill="var(--rubric)" />
    </svg>
  );
}

/**
 * The wordmark. The serif's line box is set to its own size and nudged so
 * the word's cap height is centered on the mark.
 */
export function InklingWordmark() {
  return (
    <span className="flex h-9 items-center gap-[7px] text-ink">
      <InklingMark className="size-[21px] shrink-0" />
      <span className="block translate-y-[2px] font-serif text-[21px] font-[440] leading-[21px] tracking-[-0.018em] [font-variation-settings:'opsz'_36]">
        Inkling
      </span>
    </span>
  );
}

/** The app's mark, linked home. */
export function Lockup({ href = "/" }: { href?: string }) {
  return (
    <div className="flex h-9 items-center">
      <Link href={href} aria-label="Inkling, back to your library" className="rounded-md">
        <InklingWordmark />
      </Link>
    </div>
  );
}
