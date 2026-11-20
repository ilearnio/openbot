import type { WebContents } from "electron";

export function onOwnerGone(owner: WebContents, gone: () => void): void {
  owner.once("destroyed", gone);
  owner.on("render-process-gone", gone);
  owner.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) gone();
  });
}
