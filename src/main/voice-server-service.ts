import { EventEmitter } from "node:events";
import {
  AUTOMATIC_VOICE_LANGUAGE,
  isVoiceServerRoutes,
  type SpeechAudio,
  sameCustomProviderOrigin,
  VOICE_SERVER_LIMITS,
  type VoiceLanguage,
  type VoiceServerConnection,
  type VoiceServerInput,
  type VoiceServerModels,
  type VoiceServerProbe,
  type VoiceServerProbeField,
  type VoiceServerRoutes,
  type VoiceServerSettings,
  type VoiceTranscriptionResult,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import {
  decodeVoiceServerWav,
  OPENAI_VOICES,
  VOICE_SERVER_VOICE_PATHS,
  voiceServerHost,
  voiceServerModelLists,
  voiceServerVoiceNames,
} from "@openbot/contracts/voice-server";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, registerSecretValue } from "@openbot/logging";
import { Effect, Result, Schema } from "effect";
import { type LimitedBodyFailure, readLimitedBody, readStreamedBody } from "../backend/limited-body";
import { PreferenceStore } from "./preference-file";
import type { VoiceApiKeyStore } from "./voice-api-key-store";
import { VoiceOperationError } from "./voice-model-service";

const logger = createOpenBotLogger("voice-server-service");

const PROBE_TIMEOUT_MS = 8_000;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;
const SPEECH_TIMEOUT_MS = 120_000;
const LIST_BODY_LIMIT = 1024 * 1024;
const SPEECH_BODY_LIMIT = 32 * 1024 * 1024;
const OPENAI_PCM_SAMPLE_RATE = 24_000;
const MINIMUM_SAMPLE_RATE = 8_000;
const MAXIMUM_SAMPLE_RATE = 192_000;
const PCM_CONTENT_TYPES = new Set(["audio/pcm", "audio/l16"]);
const STREAM_REFUSED_STATUSES = new Set([400, 406, 415, 422, 501]);
const SNIFF_BYTES = 4;
const WAV_CONTENT_TYPES = new Set(["audio/wav", "audio/wave", "audio/x-wav"]);

interface StoredVoiceServer {
  server: { address: string; routes: VoiceServerRoutes } | null;
}

export function createVoiceServerPreferenceStore(path: string): PreferenceStore<StoredVoiceServer> {
  return new PreferenceStore<StoredVoiceServer>({
    path,
    defaultValue: { server: null },
    decode: (parsed) => {
      if (!isDynamicRecord(parsed) || parsed.version !== 1) return null;
      const server = parsed.server;
      if (server === null) return { server: null };
      if (
        !isDynamicRecord(server) ||
        !isString(server.address) ||
        server.address.length > VOICE_SERVER_LIMITS.address ||
        !isVoiceServerRoutes(server.routes)
      )
        return null;
      return { server: { address: server.address, routes: server.routes } };
    },
  });
}

class VoiceServerFailure extends Schema.TaggedError<VoiceServerFailure>()("VoiceServerFailure", {
  field: Schema.Literals(["address", "apiKey"]),
  message: Schema.String,
}) {}

class SpeechStreamUnsupported extends Schema.TaggedError<SpeechStreamUnsupported>()("SpeechStreamUnsupported", {}) {}

interface VoiceServerEvents {
  settings: [settings: VoiceServerSettings | null];
}

interface VoiceServerServiceOptions {
  preferences: PreferenceStore<StoredVoiceServer>;
  apiKeys: VoiceApiKeyStore;
  fetch?: typeof fetch;
}

export class VoiceServerService extends EventEmitter<VoiceServerEvents> {
  readonly #preferences: PreferenceStore<StoredVoiceServer>;
  readonly #apiKeys: VoiceApiKeyStore;
  readonly #fetch: typeof fetch;

  constructor(options: VoiceServerServiceOptions) {
    super();
    this.#preferences = options.preferences;
    this.#apiKeys = options.apiKeys;
    this.#fetch = options.fetch ?? fetch;
  }

  get(): VoiceServerSettings | null {
    const { server } = this.#preferences.get();
    if (!server) return null;
    return { address: server.address, hasApiKey: this.#apiKeys.get() !== null, routes: { ...server.routes } };
  }

  dictates(): boolean {
    return this.#preferences.get().server?.routes.dictation === true;
  }

  speaks(): boolean {
    return this.#preferences.get().server?.routes.speech === true;
  }

  readonly probe = Effect.fn("VoiceServer.probe")(function* (
    this: VoiceServerService,
    connection: VoiceServerConnection,
  ) {
    const target = { address: connection.address, apiKey: this.#keyFor(connection) };
    return yield* listModels(this.#fetch, target).pipe(
      Effect.map((models): VoiceServerProbe => ({ ok: true, models })),
      Effect.catch((failure) =>
        Effect.succeed<VoiceServerProbe>({ ok: false, field: failure.field, message: failure.message }),
      ),
    );
  }).bind(this);

  readonly set = Effect.fn("VoiceServer.set")(function* (this: VoiceServerService, input: VoiceServerInput | null) {
    const apiKey = input ? this.#keyFor(input) : null;
    const previousKey = this.#apiKeys.get();
    yield* this.#apiKeys.set(apiKey).pipe(Effect.mapError(({ cause }) => new VoiceOperationError({ cause })));
    const restoreKey = this.#apiKeys.set(previousKey).pipe(
      Effect.catch(() => this.#apiKeys.set(null)),
      Effect.ignore,
    );
    yield* this.#preferences.set({ server: input ? { address: input.address, routes: input.routes } : null }).pipe(
      Effect.tapError(() => restoreKey),
      Effect.mapError(({ cause }) => new VoiceOperationError({ cause })),
    );
    const settings = this.get();
    this.emit("settings", settings);
    return settings;
  }).bind(this);

  readonly transcribe = Effect.fn("VoiceServer.transcribe")(function* (
    this: VoiceServerService,
    wav: Uint8Array,
    language: VoiceLanguage,
  ) {
    const { server } = this.#preferences.get();
    const model = server?.routes.dictation ? server.routes.transcriptionModel : null;
    if (!server || !model) return yield* routeOff();
    return yield* transcribeRecording(
      this.#fetch,
      { address: server.address, apiKey: this.#apiKeys.get() },
      model,
      wav,
      language,
      { label: "Voice server" },
    );
  }).bind(this);

  readonly speak = Effect.fn("VoiceServer.speak")(function* (
    this: VoiceServerService,
    text: string,
    signal?: AbortSignal,
  ) {
    const request = this.#speechRequest(text, "wav");
    if (!request) return yield* routeOff();
    return yield* exchange(
      this.#fetch,
      request.target,
      "audio/speech",
      { ...request.init, signal },
      SPEECH_TIMEOUT_MS,
      readSpeechWav,
    ).pipe(Effect.mapError(operationError));
  }).bind(this);

  readonly speakStream = Effect.fn("VoiceServer.speakStream")(function* (
    this: VoiceServerService,
    text: string,
    receive: (audio: SpeechAudio) => void,
    signal: AbortSignal,
  ) {
    const request = this.#speechRequest(text, "pcm");
    if (!request) return yield* routeOff();
    const streamed = yield* Effect.result(
      exchange(
        this.#fetch,
        request.target,
        "audio/speech",
        { ...request.init, signal },
        SPEECH_TIMEOUT_MS,
        (response, host) => readSpeechStream(response, host, receive),
        (status) => (STREAM_REFUSED_STATUSES.has(status) ? new SpeechStreamUnsupported() : null),
      ),
    );
    if (Result.isSuccess(streamed)) return streamed.success;
    if (streamed.failure._tag === "VoiceServerFailure") return yield* operationError(streamed.failure);
    logger.info("The voice server does not stream speech. Asking for a WAV file instead.");
    receive(yield* this.speak(text, signal));
    return false;
  }).bind(this);

  #speechRequest(text: string, format: "wav" | "pcm"): { target: ServerTarget; init: RequestInit } | null {
    const { server } = this.#preferences.get();
    const routes = server?.routes;
    if (!server || !routes?.speech || !routes.speechModel || !routes.voice) return null;
    return {
      target: { address: server.address, apiKey: this.#apiKeys.get() },
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: routes.speechModel, input: text, voice: routes.voice, response_format: format }),
      },
    };
  }

  #keyFor(connection: VoiceServerConnection): string | null {
    if (connection.apiKey) {
      registerSecretValue(connection.apiKey);
      return connection.apiKey;
    }
    const saved = this.#preferences.get().server;
    return saved && sameCustomProviderOrigin(saved.address, connection.address) ? this.#apiKeys.get() : null;
  }
}

interface ServerTarget {
  address: string;
  apiKey: string | null;
}

interface TranscriptionCaller {
  label: string;
  refused?: StatusText;
}

type StatusText = (status: number) => string | null;
type StatusRefusal<E> = (status: number) => string | NoInfer<E> | null;

export function transcribeRecording(
  fetcher: typeof fetch,
  target: ServerTarget,
  model: string,
  wav: Uint8Array,
  language: VoiceLanguage,
  caller: TranscriptionCaller,
): Effect.Effect<VoiceTranscriptionResult, VoiceOperationError> {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
  form.set("model", model);
  form.set("response_format", "json");
  if (language !== AUTOMATIC_VOICE_LANGUAGE) form.set("language", language);
  const startedAt = Date.now();
  return exchange(
    fetcher,
    target,
    "audio/transcriptions",
    { method: "POST", body: form },
    TRANSCRIPTION_TIMEOUT_MS,
    (response, host) => readJson(response, host, LIST_BODY_LIMIT),
    caller.refused,
  ).pipe(
    Effect.flatMap((body) =>
      isDynamicRecord(body) && isString(body.text)
        ? Effect.succeed({ text: body.text.trim() } satisfies VoiceTranscriptionResult)
        : Effect.fail(invalidAnswer(target.address)),
    ),
    Effect.mapError((failure) => {
      logger.warn(`${caller.label} transcription failed after ${Date.now() - startedAt}ms.`);
      return new VoiceOperationError({ cause: new Error(failure.message) });
    }),
  );
}

function operationError(failure: VoiceServerFailure) {
  return new VoiceOperationError({ cause: new Error(failure.message) });
}

function routeOff() {
  return new VoiceOperationError({ cause: new Error(sourceText("error.voice.server.routeOff")) });
}

function invalidAnswer(address: string) {
  return new VoiceServerFailure({
    field: "address",
    message: sourceText("error.voice.server.invalidAnswer", { host: voiceServerHost(address) }),
  });
}

function invalidAudio(host: string) {
  return new VoiceServerFailure({ field: "address", message: sourceText("error.voice.server.invalidAudio", { host }) });
}

function exchange<A, E = never>(
  fetcher: typeof fetch,
  target: ServerTarget,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  read: (response: Response, host: string) => Effect.Effect<A, VoiceServerFailure | E>,
  refused?: StatusRefusal<E>,
): Effect.Effect<A, VoiceServerFailure | E> {
  const host = voiceServerHost(target.address);
  const fail = (field: VoiceServerProbeField, message: string) => new VoiceServerFailure({ field, message });
  return Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (controller) =>
      Effect.gen(function* () {
        if (init.signal) linkAbort(init.signal, controller);
        const url = yield* Effect.try({
          try: () => {
            const base = new URL(target.address);
            base.pathname = `${base.pathname.replace(/\/+$/, "")}/${path}`;
            return base;
          },
          catch: () => fail("address", sourceText("error.provider.baseUrlInvalid")),
        });
        const headers = new Headers(init.headers);
        headers.set("Accept", "*/*");
        if (target.apiKey) headers.set("Authorization", `Bearer ${target.apiKey}`);
        const response = yield* Effect.tryPromise({
          try: () => fetcher(url, { ...init, headers, redirect: "manual", signal: controller.signal }),
          catch: () => fail("address", sourceText("error.provider.discoveryUnreachable", { host })),
        });
        const explained = response.ok ? null : (refused?.(response.status) ?? null);
        if (typeof explained === "string") return yield* fail("address", explained);
        if (explained) return yield* Effect.fail(explained);
        if (response.status >= 300 && response.status < 400)
          return yield* fail("address", sourceText("error.provider.discoveryRedirect", { host }));
        if (response.status === 401 || response.status === 403)
          return yield* fail("apiKey", sourceText("error.voice.server.keyRefused", { host }));
        if (!response.ok)
          return yield* fail(
            "address",
            sourceText("error.provider.discoveryHttp", { host, status: String(response.status) }),
          );
        return yield* read(response, host);
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(fail("address", sourceText("error.provider.discoveryTimeout", { host }))),
        }),
      ),
    (controller) => Effect.sync(() => controller.abort()),
  );
}

function linkAbort(signal: AbortSignal, controller: AbortController): void {
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
}

function bodyFailure(host: string) {
  return (reason: LimitedBodyFailure) =>
    reason === "too-large"
      ? new VoiceServerFailure({ field: "address", message: sourceText("error.voice.server.tooLarge", { host }) })
      : new VoiceServerFailure({
          field: "address",
          message: sourceText("error.provider.discoveryUnreachable", { host }),
        });
}

function readBody(response: Response, host: string, limit: number): Effect.Effect<Buffer, VoiceServerFailure> {
  return readLimitedBody(response, limit, bodyFailure(host));
}

function readSpeechWav(response: Response, host: string): Effect.Effect<SpeechAudio, VoiceServerFailure> {
  return readBody(response, host, SPEECH_BODY_LIMIT).pipe(
    Effect.flatMap((wav) => {
      const audio = decodeVoiceServerWav(wav);
      return audio ? Effect.succeed(audio) : Effect.fail(invalidAudio(host));
    }),
  );
}

function readSpeechStream(
  response: Response,
  host: string,
  deliver: (audio: SpeechAudio) => void,
): Effect.Effect<boolean, VoiceServerFailure | SpeechStreamUnsupported> {
  const declared = declaredSpeechFormat(response.headers.get("content-type"));
  if (declared === "wav")
    return readSpeechWav(response, host).pipe(
      Effect.map((audio) => {
        deliver(audio);
        return false;
      }),
    );
  if (declared === "other") return Effect.fail(new SpeechStreamUnsupported());
  const sampleRate = streamSampleRate(response.headers.get("x-sample-rate"));
  let format: SpeechBodyFormat | undefined = declared === "pcm" ? "pcm" : undefined;
  let held = Buffer.alloc(0);
  let delivered = 0;
  const forward = (bytes: Uint8Array) => {
    const joined = Buffer.concat([held, bytes]);
    const even = joined.byteLength - (joined.byteLength % 2);
    held = joined.subarray(even);
    if (even === 0) return;
    delivered += even;
    deliver({ pcm: new Uint8Array(joined.subarray(0, even)), sampleRate });
  };
  return readStreamedBody(response, SPEECH_BODY_LIMIT, bodyFailure(host), (bytes) => {
    if (format === "pcm") return forward(bytes);
    held = Buffer.concat([held, bytes]);
    if (format === undefined && held.byteLength >= SNIFF_BYTES) format = sniffSpeechFormat(held);
    if (format !== "pcm") return;
    const start = held;
    held = Buffer.alloc(0);
    forward(start);
  }).pipe(
    Effect.flatMap((): Effect.Effect<boolean, VoiceServerFailure | SpeechStreamUnsupported> => {
      if (format === "wav") {
        const audio = decodeVoiceServerWav(held);
        if (!audio) return Effect.fail(invalidAudio(host));
        deliver(audio);
        return Effect.succeed(false);
      }
      if (format === "other") return Effect.fail(new SpeechStreamUnsupported());
      if (format === undefined) forward(Buffer.alloc(0));
      return delivered > 0 ? Effect.succeed(true) : Effect.fail(invalidAudio(host));
    }),
  );
}

type SpeechBodyFormat = "pcm" | "wav" | "other";

function declaredSpeechFormat(contentType: string | null): SpeechBodyFormat | "unknown" {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (PCM_CONTENT_TYPES.has(type)) return "pcm";
  if (WAV_CONTENT_TYPES.has(type)) return "wav";
  if (type === "" || type === "application/octet-stream") return "unknown";
  return "other";
}

function sniffSpeechFormat(head: Buffer): SpeechBodyFormat {
  const tag = head.toString("latin1", 0, 4);
  if (tag === "RIFF") return "wav";
  if (
    tag.startsWith("ID3") ||
    tag === "OggS" ||
    tag === "fLaC" ||
    (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)
  )
    return "other";
  return "pcm";
}

function streamSampleRate(header: string | null): number {
  const rate = Number(header);
  return Number.isInteger(rate) && rate >= MINIMUM_SAMPLE_RATE && rate <= MAXIMUM_SAMPLE_RATE
    ? rate
    : OPENAI_PCM_SAMPLE_RATE;
}

function readJson(response: Response, host: string, limit: number): Effect.Effect<unknown, VoiceServerFailure> {
  return readBody(response, host, limit).pipe(
    Effect.flatMap((body) =>
      Effect.try({
        try: (): unknown => JSON.parse(body.toString("utf8")),
        catch: () =>
          new VoiceServerFailure({
            field: "address",
            message: sourceText("error.voice.server.invalidAnswer", { host }),
          }),
      }),
    ),
  );
}

function listModels(fetcher: typeof fetch, target: ServerTarget): Effect.Effect<VoiceServerModels, VoiceServerFailure> {
  return Effect.gen(function* () {
    const body = yield* exchange(fetcher, target, "models", { method: "GET" }, PROBE_TIMEOUT_MS, (response, host) =>
      readJson(response, host, LIST_BODY_LIMIT),
    );
    const lists = voiceServerModelLists(body);
    if (!lists)
      return yield* new VoiceServerFailure({
        field: "address",
        message: sourceText("error.provider.discoveryInvalid", { host: voiceServerHost(target.address) }),
      });
    const { transcription, speech } = lists;
    const voices = speech.length > 0 ? yield* listVoices(fetcher, target) : [];
    return { transcription, speech, voices };
  });
}

function listVoices(fetcher: typeof fetch, target: ServerTarget): Effect.Effect<string[]> {
  const attempt = (path: string) =>
    exchange(fetcher, target, path, { method: "GET" }, PROBE_TIMEOUT_MS, (response, host) =>
      readJson(response, host, LIST_BODY_LIMIT),
    ).pipe(
      Effect.map(voiceServerVoiceNames),
      Effect.catch(() => Effect.succeed([])),
    );
  return Effect.gen(function* () {
    for (const path of VOICE_SERVER_VOICE_PATHS) {
      const voices = yield* attempt(path);
      if (voices.length > 0) return voices;
    }
    return [...OPENAI_VOICES];
  });
}
