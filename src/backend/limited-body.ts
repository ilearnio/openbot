import { Effect } from "effect";

export type LimitedBodyFailure = "too-large" | "unreadable";

export function readLimitedBody<E>(
  response: Response,
  limit: number,
  failure: (reason: LimitedBodyFailure) => E,
): Effect.Effect<Buffer, E> {
  const chunks: Uint8Array[] = [];
  return readStreamedBody(response, limit, failure, (chunk) => chunks.push(chunk)).pipe(
    Effect.map(() => Buffer.concat(chunks)),
  );
}

export function readStreamedBody<E>(
  response: Response,
  limit: number,
  failure: (reason: LimitedBodyFailure) => E,
  receive: (chunk: Uint8Array) => void,
): Effect.Effect<number, E> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return Effect.fail(failure("too-large"));
  const reader = response.body?.getReader();
  if (!reader) return Effect.succeed(0);
  return Effect.acquireUseRelease(
    Effect.succeed(reader),
    (body) =>
      Effect.gen(function* () {
        let size = 0;
        for (;;) {
          const chunk = yield* Effect.tryPromise({ try: () => body.read(), catch: () => failure("unreadable") });
          if (chunk.done) return size;
          size += chunk.value.byteLength;
          if (size > limit) return yield* Effect.fail(failure("too-large"));
          receive(chunk.value);
        }
      }),
    (body) =>
      Effect.promise(() => body.cancel().catch(() => undefined)).pipe(
        Effect.ensuring(Effect.sync(() => body.releaseLock())),
      ),
  );
}
