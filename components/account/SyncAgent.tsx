"use client";

import { useEffect } from "react";
import { useAccount } from "@/lib/auth-client";
import { useStore } from "@/lib/store";
import { startSync } from "@/lib/sync";

/** Runs account sync while someone is signed in. In single-user mode that is always. Renders nothing. */
export function SyncAgent() {
  const { loaded, signedIn, userId } = useAccount();
  useEffect(() => {
    if (!loaded || !signedIn || !userId) return;
    useStore.getState().hydrate();
    const s = startSync(userId);
    return () => s.stop();
  }, [loaded, signedIn, userId]);
  return null;
}
