import { PrivateApp } from "@/components/private/private-app";

/**
 * `/private`. Public, static, no server data. Thread selection is
 * client state, never in the URL, so no page view or server log can carry a
 * joinable thread id.
 */
export default function PrivatePage() {
  return <PrivateApp />;
}
