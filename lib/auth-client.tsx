"use client";

import { createContext, useContext, type ReactNode } from "react";

export type AccountState = {
  loaded: boolean;
  signedIn: boolean;
  userId: string | null;
  name: string | null;
  firstName: string | null;
  mode: "single" | "clerk";
};

const EMPTY: AccountState = { loaded: false, signedIn: false, userId: null, name: null, firstName: null, mode: "single" };

const AccountContext = createContext<AccountState>(EMPTY);

export function AccountProvider({ value, children }: { value: AccountState; children: ReactNode }) {
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountState {
  return useContext(AccountContext);
}

/** Clerk sign-in prompts. Single-user mode is already signed in, so this renders nothing. */
export function SignedOut({ children }: { children: ReactNode }) {
  const account = useAccount();
  if (!account.loaded || account.signedIn || account.mode !== "clerk") return null;
  return <>{children}</>;
}
