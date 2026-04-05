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
    .handler(a.handler.function(chatAgent)),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});
