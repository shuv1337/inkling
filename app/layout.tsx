import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible_Next, Literata, Newsreader, Schibsted_Grotesk } from "next/font/google";
import { BOOT_SCRIPT } from "@/lib/settings";
import "./globals.css";
import { Tooltips } from "@/components/ui/Tooltips";
import { SyncAgent } from "@/components/account/SyncAgent";
import { AccountProvider } from "@/lib/auth-client";
import { authMode, singleUserId } from "@/lib/auth";
import { OG_IMAGE, SITE_URL } from "@/lib/brand";

const serif = Newsreader({
  subsets: ["latin", "latin-ext"],
  axes: ["opsz"],
  style: ["normal", "italic"],
  variable: "--nf-serif",
  display: "swap",
});

const sans = Schibsted_Grotesk({
  subsets: ["latin"],
  variable: "--nf-sans",
  display: "swap",
});

// Optional reading faces: declared here, fetched only when a reader picks them.
const book = Literata({
  subsets: ["latin", "latin-ext"],
  axes: ["opsz"],
  style: ["normal", "italic"],
  variable: "--nf-book",
  display: "swap",
  preload: false,
});

const legible = Atkinson_Hyperlegible_Next({
  subsets: ["latin", "latin-ext"],
  style: ["normal", "italic"],
  variable: "--nf-legible",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

const DESCRIPTION = "Highlight any line and ask it anything. An open model writes the answer in the margin, beside the words, citing the paragraphs it used.";

async function ClerkShell({ children }: { children: React.ReactNode }) {
  const { ClerkRoot } = await import("@/components/account/ClerkRoot");
  return <ClerkRoot>{children}</ClerkRoot>;
}

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Inkling", template: "%s" },
  description: DESCRIPTION,
  applicationName: "Inkling",
  openGraph: { type: "website", siteName: "Inkling", title: "Inkling", description: DESCRIPTION, url: "/", images: [OG_IMAGE] },
  twitter: { card: "summary_large_image", title: "Inkling", description: DESCRIPTION, images: [OG_IMAGE.url] },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f3ec" },
    { media: "(prefers-color-scheme: dark)", color: "#151412" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Clerk is optional. Importing it in single-user mode makes the app demand keys it does not have.
  const shell =
    authMode() === "clerk" ? (
      <ClerkShell>
        {children}
        <SyncAgent />
      </ClerkShell>
    ) : (
      <AccountProvider value={{ loaded: true, signedIn: true, userId: singleUserId(), name: null, firstName: null, mode: "single" }}>
        {children}
        <SyncAgent />
      </AccountProvider>
    );
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${book.variable} ${legible.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body>
        {shell}
        <Tooltips />
      </body>
    </html>
  );
}
