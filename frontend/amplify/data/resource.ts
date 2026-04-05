import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { chatAgent } from '../functions/chat-agent/resource';

const schema = a.schema({
  ChatResponse: a.customType({
    reply: a.string().required(),
    sessionId: a.string().required(),
    traceId: a.string(),
    statusCode: a.integer(),
  }),
  /** Individual text delta published by the Lambda during streaming. */
  ChatChunk: a.customType({
    sessionId: a.string().required(),
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
    .arguments({ sessionId: a.string().required() })
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.custom({ entry: './on-chat-chunk.js' }))
});

const schemaWithResourceAccess = schema.authorization((allow) => [
  allow.resource(chatAgent).to(['mutate']),
]);

export type Schema = ClientSchema<typeof schemaWithResourceAccess>;

export const data = defineData({
  schema: schemaWithResourceAccess,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});
