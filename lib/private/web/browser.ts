/** Small browser helpers for Private Mode. No network. */

/** Safari (desktop or iOS), excluding Chromium/Firefox builds that also say "Safari". */
export function isSafariUA(ua: string): boolean {
  return /Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|Edg|EdgiOS|FxiOS|Firefox|OPR|Android)\//.test(ua);
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
