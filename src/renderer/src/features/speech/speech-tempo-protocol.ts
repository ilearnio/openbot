export const SPEECH_TEMPO_PROCESSOR = "speech-tempo";

export type SpeechTempoCommand =
  | { type: "push"; samples: Float32Array }
  | { type: "end" }
  | { type: "tempo"; tempo: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" };

export interface SpeechTempoReport {
  consumedSeconds: number;
  drained: boolean;
}
