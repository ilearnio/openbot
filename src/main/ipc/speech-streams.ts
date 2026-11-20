import type { WebContents } from "electron";

export class OwnedSpeechStreams {
  readonly #streams = new WeakMap<WebContents, Map<string, AbortController>>();

  start(owner: WebContents, streamId: string): AbortController {
    const controller = new AbortController();
    const streams = this.#streams.get(owner) ?? this.#watch(owner);
    streams.get(streamId)?.abort();
    streams.set(streamId, controller);
    return controller;
  }

  finish(owner: WebContents, streamId: string): void {
    this.#streams.get(owner)?.delete(streamId);
  }

  cancel(owner: WebContents, streamId: string): void {
    this.#streams.get(owner)?.get(streamId)?.abort();
  }

  #watch(owner: WebContents): Map<string, AbortController> {
    const streams = new Map<string, AbortController>();
    this.#streams.set(owner, streams);
    const cancelAll = () => {
      for (const controller of streams.values()) controller.abort();
      streams.clear();
    };
    owner.once("destroyed", cancelAll);
    owner.on("render-process-gone", cancelAll);
    owner.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) cancelAll();
    });
    return streams;
  }
}
