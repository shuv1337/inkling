"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { useAccount } from "@/lib/auth-client";

type ClerkSignIn = ComponentType<{ mode?: "modal" | "redirect"; children: ReactNode }>;

/**
 * Clerk's sign-in button. The SDK is loaded only when AUTH_MODE=clerk, so
 * single-user mode never asks for Clerk keys.
 */
export function SignInButton({ children }: { children: ReactNode }) {
  const { mode, signedIn } = useAccount();
  const [Btn, setBtn] = useState<ClerkSignIn | null>(null);
  useEffect(() => {
    if (mode !== "clerk" || signedIn) return;
    let cancelled = false;
    void import("@clerk/nextjs").then((mod) => {
      if (!cancelled) setBtn(() => mod.SignInButton);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, signedIn]);
  if (!Btn) return null;
  return <Btn mode="modal">{children}</Btn>;
}
