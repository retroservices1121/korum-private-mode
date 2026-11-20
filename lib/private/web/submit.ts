/**
 * Composer → controller wiring for Private Mode.
 *
 * The shared Composer clears its draft on submit. If the prompt then can't be
 * saved to this device, it must not vanish, and it must not clobber anything
 * newer either:
 *   - box still empty AND still the same thread → put the prompt back;
 *   - otherwise (the user typed again, or moved to another thread) leave the
 *     box alone and keep the prompt behind a "Restore message" action, which
 *     appends it to whatever is there.
 * Unexpected rejections are handled the same way, so nothing is unhandled.
 */

import {
  SAVE_FAILED_KEPT_MESSAGE,
  SAVE_FAILED_MESSAGE,
  type PrivateChatController,
} from "./private-chat-controller";

export interface SubmitUI {
  getDraft: () => string;
  restoreDraft: (text: string) => void;
  showError: (message: string, action?: { label: string; onClick: () => void }) => void;
}

export async function submitPrivateMessage(
  controller: Pick<PrivateChatController, "send" | "viewVersion"> | null,
  text: string,
  ui: SubmitUI,
): Promise<void> {
  const startedOn = controller?.viewVersion;
  const safeToRestore = () =>
    ui.getDraft().trim() === "" && controller?.viewVersion === startedOn;

  const giveBack = (failed: boolean) => {
    if (safeToRestore()) {
      ui.restoreDraft(text);
      if (failed) ui.showError(SAVE_FAILED_MESSAGE);
      return;
    }
    ui.showError(failed ? SAVE_FAILED_KEPT_MESSAGE : "Your message wasn't sent.", {
      label: "Restore message",
      onClick: () => {
        const current = ui.getDraft();
        ui.restoreDraft(current.trim() ? `${current}\n\n${text}` : text);
      },
    });
  };

  if (!controller) {
    giveBack(false);
    return;
  }
  try {
    const result = await controller.send(text);
    if (result.status === "save_failed") giveBack(true);
    else if (result.status === "ignored" && text.trim()) giveBack(false);
  } catch {
    giveBack(true);
  }
}
