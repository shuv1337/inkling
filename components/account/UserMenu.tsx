"use client";

import { useEffect, useState, type ComponentType } from "react";
import { useAccount } from "@/lib/auth-client";

type ClerkUserButton = ComponentType<{ appearance?: { elements?: { avatarBox?: string } } }>;

/** Clerk's avatar menu. Loaded only in clerk mode. */
export function UserMenu() {
  const { mode, signedIn } = useAccount();
  const [Btn, setBtn] = useState<ClerkUserButton | null>(null);
  useEffect(() => {
    if (mode !== "clerk" || !signedIn) return;
    let cancelled = false;
    void import("@clerk/nextjs").then((mod) => {
      if (!cancelled) setBtn(() => mod.UserButton);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, signedIn]);
  if (!Btn) return null;
  return (
    <span className="grid size-9 place-items-center">
      <Btn appearance={{ elements: { avatarBox: "size-7" } }} />
    </span>
  );
}
