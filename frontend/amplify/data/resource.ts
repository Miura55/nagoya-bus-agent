import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { chatAgent } from '../functions/chat-agent/resource';

const schema = a.schema({
  /**
   * A user-visible conversation. The model id is also used as AgentCore's
   * runtimeSessionId, so selecting a record restores the matching memory.
   */
  ChatSession: a
    .model({
      owner: a.string().required(),
      title: a.string().required(),
      lastMessageAt: a.datetime().required(),
    })
    .authorization((allow) => [
      allow.ownerDefinedIn('owner').identityClaim('sub').to(['read']),
    ]),
  /** Display history persisted independently from AgentCore Memory. */
  ChatMessage: a
    .model({
      owner: a.string().required(),
      sessionId: a.string().required(),
      requestId: a.string().required(),
      role: a.enum(['user', 'assistant']),
      content: a.string().required(),
      // Stable chronological key shared by the user/assistant pair.
      orderKey: a.string().required(),
    })
    .authorization((allow) => [
      allow.ownerDefinedIn('owner').identityClaim('sub').to(['read']),
    ]),
  ChatResponse: a.customType({
    reply: a.string().required(),
    sessionId: a.string().required(),
    requestId: a.string(),
    traceId: a.string(),
    statusCode: a.integer(),
  }),
  /** Individual text delta published by the Lambda during streaming. */
  ChatChunk: a.customType({
    sessionId: a.string().required(),
    requestId: a.string().required(),
    sequence: a.integer().required(),
    delta: a.string(),
    done: a.boolean().required(),
    error: a.string(),
  }),
  healthCheck: a
    .query()
    .returns(a.ref('ChatResponse'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(chatAgent)),
  chat: a
    .mutation()
    .arguments({
      prompt: a.string().required(),
      sessionId: a.string(),
      requestId: a.string(),
    })
    .returns(a.ref('ChatResponse'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(chatAgent)),
  /**
   * Internal mutation called only by the Lambda to push streaming chunks.
   * Triggering this mutation causes any connected onChatChunk subscription
   * to receive the chunk.
   *
   * Amplify requires both an auth rule AND a handler on every custom operation.
   * Schema-level allow.resource(chatAgent) adds Lambda IAM access on top of
   * the field-level rule (OR logic), so the Lambda can always call this even
   * though the default AuthMode is userPool.
   */
  publishChunk: a
    .mutation()
    .arguments({
      sessionId: a.string().required(),
      requestId: a.string().required(),
      sequence: a.integer().required(),
      delta: a.string(),
      done: a.boolean().required(),
      error: a.string(),
    })
    .returns(a.ref('ChatChunk'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(chatAgent)),
  /**
   * Subscription that clients use to receive streaming chunks.
   */
  onChatChunk: a
    .subscription()
    .for(a.ref('publishChunk'))
    .arguments({
      sessionId: a.string().required(),
      requestId: a.string().required(),
    })
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.custom({ entry: './on-chat-chunk.js' }))
});

const schemaWithResourceAccess = schema.authorization((allow) => [
  // The orchestration Lambda validates the Cognito owner before using this
  // service-level access to persist messages.
  allow.resource(chatAgent).to(['query', 'mutate']),
]);

export type Schema = ClientSchema<typeof schemaWithResourceAccess>;

export const data = defineData({
  schema: schemaWithResourceAccess,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});
