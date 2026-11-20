import type { WebContents } from "electron";
import { onOwnerGone } from "./owner-lifetime";

export class OwnedSpeechStreams {
  readonly #streams = new WeakMap<WebContents, Map<string, AbortController>>();

  start(owner: WebContents, streamId: string): AbortController {
    const controller = new AbortController();
    const streams = this.#streams.get(owner) ?? this.#watch(owner);
    streams.get(streamId)?.abort();
    streams.set(streamId, controller);
    return controller;
  }

  finish(owner: WebContents, streamId: string, controller: AbortController): void {
    const streams = this.#streams.get(owner);
    if (streams?.get(streamId) === controller) streams.delete(streamId);
  }

  cancel(owner: WebContents, streamId: string): void {
    this.#streams.get(owner)?.get(streamId)?.abort();
  }

  #watch(owner: WebContents): Map<string, AbortController> {
    const streams = new Map<string, AbortController>();
    this.#streams.set(owner, streams);
    onOwnerGone(owner, () => {
      for (const controller of streams.values()) controller.abort();
      streams.clear();
    });
    return streams;
  }
}
