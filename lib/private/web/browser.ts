/** Small browser helpers for Private Mode. No network. */

/** Safari (desktop or iOS), excluding Chromium/Firefox builds that also say "Safari". */
export function isSafariUA(ua: string): boolean {
  return /Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|Edg|EdgiOS|FxiOS|Firefox|OPR|Android)\//.test(ua);
}

export interface MobileHints {
  /** `navigator.maxTouchPoints`; > 1 with a "Macintosh" UA means iPadOS desktop mode. */
  maxTouchPoints?: number;
  /** `navigator.userAgentData.mobile` (Chromium only). */
  uaDataMobile?: boolean;
}

/**
 * A phone or tablet. Pure (no globals) so it is unit tested. Ordinary desktop
 * Safari and Chrome (including on a touch-screen laptop) are not mobile.
 */
export function isMobileUA(ua: string, hints: MobileHints = {}): boolean {
  if (hints.uaDataMobile === true) return true;
  if (/iPhone|iPod|iPad|Android|Mobi|Silk|Kindle|BlackBerry|BB10|Opera Mini|IEMobile|webOS/i.test(ua)) return true;
  // iPadOS 13+ requests desktop sites with a Mac UA; real Macs have no touch points.
  return /Macintosh/.test(ua) && (hints.maxTouchPoints ?? 0) > 1;
}

/** Saves text as a local file via a blob URL. Nothing is uploaded. */
export function downloadTextFile(fileName: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
