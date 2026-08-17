import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "dyno-lite — 100 MB Discord bot control center",
  description:
    "A Dyno-style Discord bot built on discord.js v14 + better-sqlite3, engineered to stay under a 100 MB RSS ceiling.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#0b0d14] text-white antialiased">{children}</body>
    </html>
  );
}
