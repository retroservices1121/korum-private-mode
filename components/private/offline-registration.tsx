"use client";
import { useEffect } from "react";

/** Registers the offline service worker (production builds only), scoped to /private. */
export function OfflineRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const report = () => navigator.serviceWorker.controller?.postMessage({
      type: "private-shell-version", buildId: process.env.NEXT_PUBLIC_PRIVATE_BUILD_ID,
    });
    report();
    navigator.serviceWorker.addEventListener("controllerchange", report);
    const timer = setInterval(report, 30_000);
    // /private (without trailing slash) covers both /private and /private/.
    void navigator.serviceWorker.register("/private-sw.js", { scope: "/private", updateViaCache: "none" }).catch(() => {
      // Offline shell is best effort on unsupported browsers; inference stays local.
    });
    return () => {
      clearInterval(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", report);
    };
  }, []);
  return null;
}
