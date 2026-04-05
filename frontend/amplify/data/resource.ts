import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { chatAgent } from '../functions/chat-agent/resource';

const schema = a.schema({
  ChatResponse: a.customType({
    reply: a.string().required(),
    sessionId: a.string().required(),
    traceId: a.string(),
    statusCode: a.integer(),
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
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});
