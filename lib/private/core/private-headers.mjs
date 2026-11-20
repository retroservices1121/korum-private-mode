export function privateHeaders(origin, isDev = false) {
  const PRIVATE_CSP = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'none'",
    "media-src 'none'",
    "font-src 'self'",
    `connect-src 'self' ${origin}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  return [
    { key: "Content-Security-Policy", value: PRIVATE_CSP },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ];
}
