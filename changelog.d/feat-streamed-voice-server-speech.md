### Changed

- Spoken replies from a voice server now start while the server makes the audio. OpenBot asks the
  server for streamed audio in the OpenAI format and plays each part as it comes. With a local server,
  the first words come in about 0.2 seconds. When the server streams, OpenBot sends a reply of up to
  1,000 characters in one request, so the voice keeps its flow between sentences. A server that cannot
  stream sends a full file, as before.
- A change to the reply speed now applies at once, also in the middle of a sentence. The voice keeps
  its natural pitch at each speed.
