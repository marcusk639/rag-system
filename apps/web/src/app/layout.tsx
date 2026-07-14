import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "RAG Knowledge Hub",
  description:
    "Ask questions and get source-cited answers from your documents.",
};

// Reads the per-request nonce that middleware.ts generates and forwards via
// the x-nonce request header. Calling headers() here is what makes this a
// dynamically-rendered Server Component — required for nonce-based CSP per
// Next.js's own App Router CSP guide (a statically-rendered page has no
// per-request nonce to read). The nonce itself isn't applied to anything
// below by hand: Next.js's own script-injection machinery parses the
// nonce out of the CSP response header and auto-applies it to
// framework-injected scripts/styles, so just forwarding it via
// middleware is sufficient — reading it here documents that dependency
// and is required for any future <Script>/inline-style use in this layout.
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nonce = (await headers()).get("x-nonce");

  return (
    <html lang="en">
      <body className={inter.className} data-csp-nonce={nonce ?? undefined}>
        {children}
      </body>
    </html>
  );
}
