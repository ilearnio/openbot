import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OpenBotDesktopApi, VoiceServerSettings } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { translateFor } from "@openbot/i18n";
import { createOpenBotLogger } from "@openbot/logging";
import type { Page } from "playwright-core";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

declare global {
  interface Window {
    openbot: OpenBotDesktopApi;
  }
}

const OUT = resolve(import.meta.dirname, "../.openbot-build/voice-server-smoke");
const t = translateFor("en");
const KEY = "smoke-voice-key-7f3a";
const TRANSCRIPTION_MODEL = "Systran/faster-whisper-small";
const SPEECH_MODEL = "speaches-ai/Kokoro-82M-v1.0-ONNX";
const VOICES = ["af_heart", "am_adam"];
const TRANSCRIPT = "Voice server smoke transcript";
const SPEECH_RATE = 24_000;
const SPEECH_SAMPLES = 6_000;
const STREAM_SAMPLES = 24_000;
const STREAM_TEXT = "Streamed speech plays as it arrives.";
const WAV_ONLY_TEXT = "This server sends only WAV files.";
const UNTYPED_WAV_TEXT = "This server sends a WAV file with no audio type.";
const SLOW_TEXT = "This stream is cancelled.";
const LONG_REPLY =
  "A streamed reply does not need a short first part. The server starts to speak at once. " +
  "So OpenBot sends the whole reply in one request. The voice keeps its flow from one sentence to the next.";
const SLOW_CHUNKS = 10;
const SLOW_CHUNK_DELAY_MS = 300;
const useLabel = new RegExp(
  `^${t("settings.voice.model.useLabel", { name: "\u0000" })
    .split("\u0000")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".+")}$`,
  "u",
);

interface Check {
  name: string;
  passed: boolean;
  detail: unknown;
}

interface SpeechPlaybackModule {
  setReplyPlaybackRate(rate: number): void;
  readAloud(
    text: string,
    language: "en",
    source: { serverId: string; agentId: string; messageId: string },
  ): Promise<{ completed: boolean; firstAudioMs: number | null; seconds: number }>;
  spokenReply(messageId: string): { duration: number } | undefined;
}

interface ServerRequest {
  method: string;
  path: string;
  authorized: boolean;
  body: unknown;
}

const instances = readDevInstanceRecords().filter(
  (record) => record.service === "app" && resolve(record.projectRoot) === resolve(process.cwd()),
);
assert.equal(instances.length, 1, "Start one dev app for this worktree first.");
const instance = instances[0];
assert.ok(instance);
assertMutationAllowed({
  command: "voice-server-smoke",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const logger = createOpenBotLogger("voice-server-smoke");

function wav(samples: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const buffer = Buffer.alloc(44 + samples.byteLength);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples.byteLength, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples.byteLength, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(buffer, 44);
  return Uint8Array.from(buffer);
}

function tone(count: number, sampleRate: number): Int16Array {
  const samples = new Int16Array(count);
  for (let index = 0; index < count; index += 1)
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 8_000);
  return samples;
}

function pcmStream(samples: Int16Array, cuts: number[], delayMs: number): ReadableStream<Uint8Array> {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const edges = [0, ...cuts, bytes.byteLength];
  let next = 0;
  return new ReadableStream({
    async pull(controller) {
      const start = edges[next];
      const end = edges[next + 1];
      if (start === undefined || end === undefined) return controller.close();
      next += 1;
      if (next > 1 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      controller.enqueue(bytes.slice(start, end));
    },
  });
}

function evenCuts(total: number, count: number): number[] {
  return Array.from({ length: count - 1 }, (_, index) => Math.round(((index + 1) * total) / count / 2) * 2);
}

const requests: ServerRequest[] = [];
const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const authorized = request.headers.get("authorization") === `Bearer ${KEY}`;
    const entry: ServerRequest = { method: request.method, path: url.pathname, authorized, body: null };
    requests.push(entry);
    if (!authorized) return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
    if (request.method === "GET" && url.pathname === "/v1/models")
      return Response.json({
        object: "list",
        data: [
          { id: TRANSCRIPTION_MODEL, object: "model", task: "automatic-speech-recognition" },
          { id: SPEECH_MODEL, object: "model", task: "text-to-speech" },
        ],
      });
    if (request.method === "GET" && url.pathname === "/v1/audio/voices") return Response.json({ voices: VOICES });
    if (request.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
      const form = await request.formData();
      const file = form.get("file");
      entry.body = {
        model: form.get("model"),
        language: form.get("language"),
        responseFormat: form.get("response_format"),
        fileName: file instanceof File ? file.name : null,
        fileType: file instanceof File ? file.type : null,
        fileBytes: file instanceof File ? file.size : 0,
        riff: file instanceof File ? new TextDecoder().decode((await file.arrayBuffer()).slice(0, 4)) : null,
      };
      return Response.json({ text: ` ${TRANSCRIPT} ` });
    }
    if (request.method === "POST" && url.pathname === "/v1/audio/speech") {
      const body = await request.json();
      entry.body = body;
      const fields = isDynamicRecord(body) ? body : {};
      if (fields.response_format === "pcm" && fields.input === WAV_ONLY_TEXT)
        return Response.json({ error: { message: "response_format pcm is not supported" } }, { status: 400 });
      if (fields.response_format === "pcm" && fields.input === UNTYPED_WAV_TEXT)
        return new Response(wav(tone(SPEECH_SAMPLES, SPEECH_RATE), SPEECH_RATE), {
          headers: { "content-type": "application/octet-stream" },
        });
      if (fields.response_format === "pcm") {
        const slow = fields.input === SLOW_TEXT;
        const samples = tone(STREAM_SAMPLES, SPEECH_RATE);
        const cuts = slow ? evenCuts(samples.byteLength, SLOW_CHUNKS) : [4_801, 9_600, 30_001];
        return new Response(pcmStream(samples, cuts, slow ? SLOW_CHUNK_DELAY_MS : 20), {
          headers: { "content-type": "audio/pcm", "x-sample-rate": String(SPEECH_RATE) },
        });
      }
      return new Response(wav(tone(SPEECH_SAMPLES, SPEECH_RATE), SPEECH_RATE), {
        headers: { "content-type": "audio/wav" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});
const address = `http://127.0.0.1:${fake.port}/v1`;
const host = `127.0.0.1:${fake.port}`;

const checks: Check[] = [];
const skipped: string[] = [];
const check = (name: string, passed: boolean, detail: unknown = null) => {
  checks.push({ name, passed, detail });
  logger.info(`${passed ? "Passed" : "Failed"}: ${name}.`);
};
const lastRequest = (path: string) => requests.findLast((entry) => entry.path === path);
const server = (page: Page) => page.evaluate(() => window.openbot.voice.getServer());

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function settingsTitle(page: Page) {
  return page.getByRole("heading", { level: 1, name: t("app.settingsPage.title"), exact: true });
}

async function openVoiceTab(page: Page) {
  const title = settingsTitle(page);
  if (!(await title.isVisible()))
    await page
      .getByRole("navigation", { name: t("app.rail.label") })
      .getByRole("button", { name: t("app.rail.settings"), exact: true })
      .click();
  await title.waitFor();
  await page.getByRole("tab", { name: t("settings.tab.voice.title"), exact: true }).click();
  await serverSection(page).waitFor();
}

async function closeSettings(page: Page) {
  await settingsTitle(page).focus();
  await page.keyboard.press("Escape");
  await settingsTitle(page).waitFor({ state: "hidden" });
}

function serverSection(page: Page) {
  return page.locator('[data-settings-row="settings.voice.server.section"]');
}

function dialog(page: Page) {
  return page.getByRole("dialog", { name: t("settings.voice.server.dialog.setUpTitle") });
}

async function setUpServer(page: Page) {
  await serverSection(page)
    .getByRole("button", { name: t("settings.voice.server.setUp"), exact: true })
    .click();
  const form = dialog(page);
  await form.waitFor();
  await form.getByLabel(t("settings.voice.server.address")).fill(address);
  await form.getByLabel(t("settings.voice.server.apiKey")).fill("wrong-key");
  await form.getByRole("button", { name: t("settings.voice.server.connect"), exact: true }).click();
  const refused = t("error.voice.server.keyRefused", { host });
  const keyError = form.getByText(refused, { exact: true });
  await keyError.waitFor();
  check("a wrong key shows its error under the key field", await keyError.isVisible(), refused);
  await form.screenshot({ path: resolve(OUT, "dialog-wrong-key.png") });

  await form.getByLabel(t("settings.voice.server.apiKey")).fill(KEY);
  await form.getByRole("button", { name: t("settings.voice.server.connect"), exact: true }).click();
  const routes = form.getByRole("region", { name: t("settings.voice.server.useFor") });
  await routes.waitFor();
  const switches = routes.getByRole("switch");
  await waitFor(
    () => switches.evaluateAll((items) => items.map((item) => item.getAttribute("aria-checked"))),
    (states) => states.length === 2 && states.every((state) => state === "true"),
  );
  const shown = (await routes.innerText()).replace(/\s+/gu, " ");
  check(
    "a server with both routes turns both on, with its first models and voice",
    shown.includes("faster-whisper-small") && shown.includes("Kokoro-82M-v1.0-ONNX") && shown.includes(VOICES[0] ?? ""),
    shown,
  );
  await form.screenshot({ path: resolve(OUT, "dialog-connected.png") });
  await form.getByRole("button", { name: t("common.save"), exact: true }).click();
  await form.waitFor({ state: "hidden" });
}

mkdirSync(OUT, { recursive: true });
const session = await connectToDevApp(instance.remoteDebuggingPort, logger, {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});
const page = session.page;
page.setDefaultTimeout(15_000);
let saved: VoiceServerSettings | null = null;
try {
  assert.equal(await page.evaluate(() => document.documentElement.lang), "en", "Set the app language to English.");
  assert.equal(await server(page), null, "Remove the voice server in Settings → Voice first.");

  await openVoiceTab(page);
  await setUpServer(page);
  saved = await waitFor(
    () => server(page),
    (value) => value !== null,
  );
  check(
    "the saved server has both routes, the first models and voice, and a key",
    saved?.address === address &&
      saved.hasApiKey &&
      saved.routes.dictation &&
      saved.routes.speech &&
      saved.routes.transcriptionModel === TRANSCRIPTION_MODEL &&
      saved.routes.speechModel === SPEECH_MODEL &&
      saved.routes.voice === VOICES[0],
    saved,
  );
  check("the saved settings do not hold the key", !JSON.stringify(saved).includes(KEY));
  const summary = (await serverSection(page).innerText()).replace(/\s+/gu, " ");
  check(
    "the Voice tab shows the server, its models and its voice",
    summary.includes(host) &&
      summary.includes(t("settings.voice.server.dictationSummary", { model: "faster-whisper-small" })) &&
      summary.includes(
        t("settings.voice.server.speechSummary", { model: "Kokoro-82M-v1.0-ONNX", voice: VOICES[0] ?? "" }),
      ),
    summary,
  );

  const notes = await page
    .getByRole("tabpanel")
    .getByText(t("settings.voice.model.serverDictates"), { exact: true })
    .count();
  check("the Model row says that the server takes dictation", notes === 1, notes);
  const language = page
    .locator('[data-settings-row="settings.voice.language.section"]')
    .getByRole("button", { name: t("settings.voice.language.section") });
  check("the dictation language can be set for the server", await language.isEnabled());
  const voiceRows = await page.locator('[data-settings-row="settings.voice.speech.voice.title"]').count();
  check("the Supertonic voice row is hidden", voiceRows === 0, voiceRows);
  await page.getByRole("tabpanel").screenshot({ path: resolve(OUT, "voice-tab.png") });

  const prepared = await page.evaluate(() => window.openbot.voice.prepareModel());
  check("the dictation model is ready at once", prepared.phase === "ready", prepared);
  const probe = await page.evaluate((target) => window.openbot.voice.probeServer(target), {
    address,
    apiKey: null,
  });
  check("a test with no key uses the saved key", probe.ok, probe);
  check("a test result does not hold the key", !JSON.stringify(probe).includes(KEY));
  const recording = Array.from(wav(tone(8_000, 16_000), 16_000));
  const transcript = await page.evaluate(
    (audio) => window.openbot.voice.transcribe({ audio: new Uint8Array(audio) }),
    recording,
  );
  const transcription = lastRequest("/v1/audio/transcriptions");
  check("transcribe returns the server's text", transcript.text === TRANSCRIPT, transcript);
  check(
    "transcribe sends the WAV and the model with the key",
    transcription?.authorized === true &&
      JSON.stringify(transcription.body).includes(TRANSCRIPTION_MODEL) &&
      JSON.stringify(transcription.body).includes('"riff":"RIFF"'),
    transcription,
  );
  const speech = await page.evaluate(async () => {
    const audio = await window.openbot.voice.speak({ text: "Hello from the voice server.", language: "en" });
    return { sampleRate: audio.sampleRate, bytes: audio.pcm.byteLength };
  });
  const speechRequest = lastRequest("/v1/audio/speech");
  check(
    "speak plays the server's WAV",
    speech.sampleRate === SPEECH_RATE && speech.bytes === SPEECH_SAMPLES * 2,
    speech,
  );
  check(
    "speak sends the model, the voice and the text with the key",
    speechRequest?.authorized === true &&
      JSON.stringify(speechRequest.body) ===
        JSON.stringify({
          model: SPEECH_MODEL,
          input: "Hello from the voice server.",
          voice: VOICES[0],
          response_format: "wav",
        }),
    speechRequest,
  );

  const streamed = await page.evaluate(async (text) => {
    const streamId = crypto.randomUUID();
    const chunks: { bytes: number; sampleRate: number; beforeEnd: boolean }[] = [];
    let ended = false;
    const stop = window.openbot.voice.onSpeechChunk((chunk) => {
      if (chunk.streamId === streamId)
        chunks.push({ bytes: chunk.pcm.byteLength, sampleRate: chunk.sampleRate, beforeEnd: !ended });
    });
    await window.openbot.voice.speakStream({ streamId, text, language: "en" });
    ended = true;
    stop();
    return chunks;
  }, STREAM_TEXT);
  check(
    "speakStream delivers the streamed PCM in even chunks before the request ends",
    streamed.length >= 2 &&
      streamed.every((chunk) => chunk.bytes % 2 === 0 && chunk.sampleRate === SPEECH_RATE && chunk.beforeEnd) &&
      streamed.reduce((total, chunk) => total + chunk.bytes, 0) === STREAM_SAMPLES * 2,
    streamed,
  );
  check(
    "speakStream asks the server for PCM",
    JSON.stringify(lastRequest("/v1/audio/speech")?.body) ===
      JSON.stringify({ model: SPEECH_MODEL, input: STREAM_TEXT, voice: VOICES[0], response_format: "pcm" }),
    lastRequest("/v1/audio/speech"),
  );

  const wavOnly = await page.evaluate(async (text) => {
    const streamId = crypto.randomUUID();
    const chunks: number[] = [];
    const stop = window.openbot.voice.onSpeechChunk((chunk) => {
      if (chunk.streamId === streamId) chunks.push(chunk.pcm.byteLength);
    });
    await window.openbot.voice.speakStream({ streamId, text, language: "en" });
    stop();
    return chunks;
  }, WAV_ONLY_TEXT);
  const formats = requests
    .filter((entry) => entry.path === "/v1/audio/speech" && JSON.stringify(entry.body).includes(WAV_ONLY_TEXT))
    .map((entry) => (JSON.stringify(entry.body).includes('"pcm"') ? "pcm" : "wav"));
  check(
    "a server that refuses PCM gets a WAV request, delivered as one chunk",
    wavOnly.length === 1 && wavOnly[0] === SPEECH_SAMPLES * 2 && JSON.stringify(formats) === '["pcm","wav"]',
    { chunks: wavOnly, formats },
  );

  const untyped = await page.evaluate(async (text) => {
    const streamId = crypto.randomUUID();
    const chunks: number[] = [];
    const stop = window.openbot.voice.onSpeechChunk((chunk) => {
      if (chunk.streamId === streamId) chunks.push(chunk.pcm.byteLength);
    });
    await window.openbot.voice.speakStream({ streamId, text, language: "en" });
    stop();
    return chunks;
  }, UNTYPED_WAV_TEXT);
  const untypedRequests = requests.filter(
    (entry) => entry.path === "/v1/audio/speech" && JSON.stringify(entry.body).includes(UNTYPED_WAV_TEXT),
  ).length;
  check(
    "a WAV body with no audio type is read as WAV, not played as PCM",
    untyped.length === 1 && untyped[0] === SPEECH_SAMPLES * 2 && untypedRequests === 1,
    { chunks: untyped, requests: untypedRequests },
  );

  const cancelled = await page.evaluate(async (text) => {
    const streamId = crypto.randomUUID();
    let chunks = 0;
    const stop = window.openbot.voice.onSpeechChunk((chunk) => {
      if (chunk.streamId !== streamId) return;
      chunks += 1;
      if (chunks === 1) void window.openbot.voice.cancelSpeechStream({ streamId });
    });
    const outcome = await window.openbot.voice
      .speakStream({ streamId, text, language: "en" })
      .then(() => "resolved")
      .catch((error: unknown) => String(error));
    stop();
    return { outcome, chunks };
  }, SLOW_TEXT);
  check(
    "cancelSpeechStream stops a stream early without an error",
    cancelled.outcome === "resolved" && cancelled.chunks < SLOW_CHUNKS,
    cancelled,
  );

  const playback = await page.evaluate(async (text) => {
    const playbackModule = "/src/features/speech/speech-playback.ts";
    const speech: SpeechPlaybackModule = await import(playbackModule);
    const timed = async (rate: number) => {
      speech.setReplyPlaybackRate(rate);
      const started = performance.now();
      const messageId = `voice-server-smoke-${rate}`;
      const result = await speech.readAloud(text, "en", { serverId: "smoke", agentId: "smoke", messageId });
      return {
        ...result,
        wallSeconds: (performance.now() - started) / 1_000,
        keptSeconds: speech.spokenReply(messageId)?.duration ?? null,
      };
    };
    const normal = await timed(1);
    const fast = await timed(2);
    speech.setReplyPlaybackRate(1);
    return { normal, fast };
  }, STREAM_TEXT);
  const streamSeconds = STREAM_SAMPLES / SPEECH_RATE;
  check(
    "readAloud plays a streamed reply to the end and starts before the stream ends",
    playback.normal.completed &&
      playback.normal.firstAudioMs !== null &&
      Math.abs(playback.normal.seconds - streamSeconds) < 0.01 &&
      playback.normal.wallSeconds >= streamSeconds * 0.9,
    playback.normal,
  );
  check(
    "a finished reply keeps its 1x audio for replay",
    playback.normal.keptSeconds !== null &&
      Math.abs(playback.normal.keptSeconds - streamSeconds) < 0.01 &&
      playback.fast.keptSeconds !== null &&
      Math.abs(playback.fast.keptSeconds - streamSeconds) < 0.01,
    { normal: playback.normal.keptSeconds, fast: playback.fast.keptSeconds },
  );
  check(
    "readAloud at 2x plays the same reply in about half the time",
    playback.fast.completed && playback.fast.wallSeconds < playback.normal.wallSeconds * 0.75,
    playback.fast,
  );

  const longStart = requests.length;
  const longReply = await page.evaluate(async (text) => {
    const playbackModule = "/src/features/speech/speech-playback.ts";
    const speech: SpeechPlaybackModule = await import(playbackModule);
    return speech.readAloud(text, "en", { serverId: "smoke", agentId: "smoke", messageId: "voice-server-smoke-long" });
  }, LONG_REPLY);
  const longInputs = requests
    .slice(longStart)
    .filter((entry) => entry.path === "/v1/audio/speech")
    .map((entry) => (isDynamicRecord(entry.body) ? entry.body.input : null));
  check(
    "after a stream works, a reply under the length limit goes in one request",
    longReply.completed && longInputs.length === 1 && longInputs[0] === LONG_REPLY,
    longInputs,
  );

  await closeSettings(page);
  const before = requests.length;
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      return destination.stream;
    };
  });
  const start = page.getByRole("button", { name: t("composer.voice.start"), exact: true }).first();
  if (await start.isVisible()) {
    await start.click();
    const stop = page.getByRole("button", { name: t("composer.voice.stop"), exact: true }).first();
    await stop.waitFor();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await stop.click();
    const composer = page.getByRole("textbox").first();
    const text = await waitFor(
      async () => (await composer.innerText().catch(() => "")) || (await composer.inputValue().catch(() => "")),
      (value) => value.includes(TRANSCRIPT),
    );
    const sent = requests.slice(before).filter((entry) => entry.path === "/v1/audio/transcriptions");
    check("composer dictation puts the server's text in the message field", text.includes(TRANSCRIPT), {
      text,
      requests: sent,
    });
    check(
      "composer dictation sends one recording and no live preview",
      sent.length === 1,
      sent.map((entry) => entry.body),
    );
    await page.screenshot({ path: resolve(OUT, "composer.png") });
    await composer.focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
  } else check("composer dictation", false, "Open a chat in the dev app first: no voice button is visible.");

  await openVoiceTab(page);
  await serverSection(page)
    .getByRole("button", { name: t("common.edit"), exact: true })
    .click();
  const edit = page.getByRole("dialog", { name: t("settings.voice.server.dialog.editTitle") });
  const dictationSwitch = edit.getByRole("switch", { name: t("settings.voice.server.route.dictation"), exact: true });
  await dictationSwitch.and(page.locator(":enabled")).waitFor();
  await dictationSwitch.focus();
  await page.keyboard.press("Space");
  await waitFor(
    () => dictationSwitch.getAttribute("aria-checked"),
    (state) => state === "false",
  );
  await edit.screenshot({ path: resolve(OUT, "dialog-edit.png") });
  await edit.getByRole("button", { name: t("common.save"), exact: true }).click();
  await edit.waitFor({ state: "hidden" });
  const afterEdit = await waitFor(
    () => server(page),
    (value) => value?.routes.dictation === false,
  );
  check(
    "Edit turns server dictation off, and keeps spoken replies and the saved key",
    afterEdit?.routes.dictation === false && afterEdit.routes.speech && afterEdit.hasApiKey,
    afterEdit,
  );
  const summaryAfterEdit = (await serverSection(page).innerText()).replace(/\s+/gu, " ");
  check(
    "the Voice tab no longer shows server dictation",
    !summaryAfterEdit.includes(t("settings.voice.server.dictationSummary", { model: "faster-whisper-small" })),
    summaryAfterEdit,
  );

  const use = page
    .locator('[data-settings-row="settings.voice.dictation.section"]')
    .getByRole("button", { name: useLabel });
  if (afterEdit && (await use.count()) > 0) {
    await page.evaluate((current) => window.openbot.voice.setServer({ server: { ...current, apiKey: null } }), {
      address: afterEdit.address,
      routes: { ...afterEdit.routes, dictation: true },
    });
    await use.first().click();
    const afterUse = await waitFor(
      () => server(page),
      (value) => value?.routes.dictation === false,
    );
    check(
      "Use on a local model turns server dictation off and keeps spoken replies",
      afterUse?.routes.dictation === false && afterUse.routes.speech && afterUse.hasApiKey,
      afterUse,
    );
  } else skipped.push("Use on a local model: no local dictation model is ready in this dev profile.");
  await serverSection(page)
    .getByRole("button", { name: t("common.remove"), exact: true })
    .click();
  const removed = await waitFor(
    () => server(page),
    (value) => value === null,
  );
  check("Remove deletes the server", removed === null, removed);
  saved = removed;
  await page.getByRole("tabpanel").screenshot({ path: resolve(OUT, "voice-tab-removed.png") });
  await closeSettings(page);
} finally {
  const open = page.getByRole("dialog").getByRole("button", { name: t("common.close"), exact: true });
  if (await open.isVisible().catch(() => false)) await open.click().catch(() => undefined);
  if (saved !== null)
    await page.evaluate(() => window.openbot.voice.setServer({ server: null })).catch(() => undefined);
  await session.close();
  await fake.stop(true);
}

const failures = checks.filter((entry) => !entry.passed);
writeFileSync(
  resolve(OUT, "report.json"),
  `${JSON.stringify({ address, checks, failures, skipped, requests: requests.map(({ body: _body, ...entry }) => entry) }, null, 2)}\n`,
);
logger.info(`${checks.length - failures.length}/${checks.length} checks passed, ${skipped.length} skipped`);
if (failures.length > 0) {
  logger.error("the voice server smoke failed", failures);
  process.exitCode = 1;
}
