import { OfflineRegistration } from "@/components/private/offline-registration";
import type { Metadata, Viewport } from "next";

import { ThemeProvider } from "@/components/theme/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

export const metadata: Metadata = {
  title: "Private Mode — KORUM",
  description: "Chat with an AI model that runs on your own device.",
  // Nothing about a private session belongs in a search index.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

/**
 * The app's only root layout.
 *
 * Privacy by construction: it mounts no analytics, no error reporting and no
 * authentication provider, so no third-party script or session ping can run
 * on this document. The layout uses system fonts.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className="h-full antialiased"
    >
      <body className="bg-background text-foreground min-h-full">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
          <Toaster position="top-center" />
          <OfflineRegistration />
        </ThemeProvider>
      </body>
    </html>
  );
}
