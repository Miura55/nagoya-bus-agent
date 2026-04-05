// Passthrough subscription handler.
// AppSync calls this when a client connects to onChatChunk.
// The response simply forwards ctx.result so that each publishChunk mutation
// event is delivered to matching subscribers.
export function request() {
  return {}
}

export function response(ctx) {
  return ctx.result
}
