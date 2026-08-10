import "dockview-core/dist/styles/dockview.css";
import "./shell.css";
import { bootSafely } from "./shell";
import { closeFormMenus } from "./ui";
import { allConversations } from "./conversations";
import { closeOpenSessionMenu, renderList, sessionsState } from "./sessions";
import { closeDeployMenu } from "./deploys";
import { closeRoomBannerMenu } from "./chat";
import { closeMentionPopover } from "./mention-markdown";

function closeComposerMenus(keepOpenWithin: Element | null): boolean {
  let changed = false;
  for (const conv of allConversations()) {
    if (keepOpenWithin && conv.state.host?.contains(keepOpenWithin)) continue;
    if (!conv.composer.closeMenus()) continue;
    changed = true;
    conv.redraw();
  }
  return changed;
}

document.addEventListener("click", (e) => {
  const target = e.target as Element | null;
  const inside = target?.closest(".menu-control, .composer-wrap") ?? null;
  closeComposerMenus(inside);
  if (!target?.closest(".form-menu-control")) closeFormMenus();
  if (sessionsState.openMenuId && !target?.closest(".session-menu")) {
    sessionsState.openMenuId = null;
    renderList();
  }
  closeDeployMenu(target);
  closeRoomBannerMenu(target);
  // The chip's own delegated handler runs first and has already opened or toggled it; this
  // only has to catch a click that landed somewhere else entirely.
  closeMentionPopover(target);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeComposerMenus(null);
  closeOpenSessionMenu();
  closeDeployMenu(null, true);
  closeRoomBannerMenu(null);
  closeFormMenus();
  closeMentionPopover(null, true);
});

void bootSafely();
