import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

export interface SpeechPort {
  voice: Pick<
    OpenBotDesktopApi["voice"],
    | "getSpeechSettings"
    | "setSpeechSettings"
    | "getSpeechModelStatus"
    | "downloadSpeechModel"
    | "onSpeechModelStatus"
    | "speak"
    | "speakStream"
    | "cancelSpeechStream"
    | "onSpeechChunk"
    | "warmSpeech"
    | "keepRecording"
    | "getServer"
    | "onServerSettings"
  >;
  agent: Pick<OpenBotDesktopApi["agent"], "readConversationPage" | "discardDraftAttachment">;
}

export function speechPort(): SpeechPort {
  return window.openbot;
}
