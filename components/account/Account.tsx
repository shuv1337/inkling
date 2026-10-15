"use client";

import { barBtn } from "@/components/ui/Popover";
import { SignedOut, useAccount } from "@/lib/auth-client";
import { SignInButton } from "./SignIn";
import { UserMenu } from "./UserMenu";

/** Signed out: a quiet "Sign in". Signed in with Clerk: the avatar. Single-user mode has neither. */
export function Account() {
  const { mode, signedIn, loaded } = useAccount();
  if (!loaded) return null;
  return (
    <>
      <SignedOut>
        <SignInButton>
          <button type="button" className={`${barBtn} !px-3 whitespace-nowrap`} data-tip="Keep your highlights and notes on every device">
            Sign in
          </button>
        </SignInButton>
      </SignedOut>
      {signedIn && mode === "clerk" && <UserMenu />}
    </>
  );
}
