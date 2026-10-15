import type { Metadata } from "next";
import { getUserId } from "@/lib/auth";
import { Landing } from "@/components/landing/Landing";

export const metadata: Metadata = { title: "Gloss", alternates: { canonical: "/" } };

export default async function Home() {
  const userId = await getUserId();
  return <Landing signedIn={Boolean(userId)} />;
}
