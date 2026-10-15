"use client";

import { ClerkProvider, useAuth, useUser } from "@clerk/nextjs";
import { AccountProvider, type AccountState } from "@/lib/auth-client";
import type { ReactNode } from "react";

/** Clerk's sign-in and account screens, in the page's own ink and paper, in every theme. */
const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: "var(--ink)",
    colorBackground: "var(--bg-raised)",
    colorForeground: "var(--ink)",
    colorMutedForeground: "var(--ink-3)",
    colorInput: "var(--bg)",
    colorInputForeground: "var(--ink)",
    colorBorder: "var(--rule-strong)",
    colorNeutral: "var(--ink)",
    fontFamily: "var(--font-sans)",
    borderRadius: "12px",
  },
};

function Bridge({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const { user } = useUser();
  const value: AccountState = {
    loaded: auth.isLoaded,
    signedIn: Boolean(auth.isSignedIn),
    userId: auth.userId ?? null,
    name: user?.fullName ?? null,
    firstName: user?.firstName ?? null,
    mode: "clerk",
  };
  return <AccountProvider value={value}>{children}</AccountProvider>;
}

export function ClerkRoot({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider appearance={CLERK_APPEARANCE}>
      <Bridge>{children}</Bridge>
    </ClerkProvider>
  );
}
