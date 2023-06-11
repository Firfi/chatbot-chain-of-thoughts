import express from 'express';
import openai from './openai/connection';
import { ChatCompletionRequestMessage } from 'openai/api';
import { getMainPrompt, getTrainingAnswer } from './prompts';
import * as S from "@effect/schema/Schema";
import telebot from './telegram/connection';
import { assertExists } from './utils';
import { CreateChatCompletionResponse } from 'openai';
import { ChatId } from 'node-telegram-bot-api';
import orderedJson from 'json-order';
import { PropertyMap } from 'json-order/dist/models';
import { pipe } from 'fp-ts/function';
import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';

const host = process.env.HOST ?? 'localhost';
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

const app = express();

type Message = ({
  role: 'user',
  handle: string, // user handle type todo
  message: string,
} | {
  // TODO think of thoughts/answer ordering, matters for history?
  role: 'actor',
  handle: string, // actor handle type todo
  thoughts: readonly string[],
  // messageId?: string,
  answer: string,
  propertyMap: PropertyMap
});
const messagesPerChat: {[k in ChatId]: Message[]} = {};

const GptActorResponseSchema = S.record(S.string, S.struct({
  thoughts: S.array(S.string),
  answer: S.string,
}));

type GptActorResponseSchemaType = S.To<typeof GptActorResponseSchema>;

const GptUserQuerySchema = S.record(S.string, S.string);

type GptUserQuerySchemaType = S.To<typeof GptUserQuerySchema>;
const getMessages = (chatId: ChatId, newMessage: Message & {role: 'user'}): ChatCompletionRequestMessage[] => (messagesPerChat[chatId] || []).concat([newMessage]).map((message) => ({
  role: message.role === 'user' ? 'user' : 'assistant',
  content: orderedJson.stringify(message.role === 'user' ? {[message.handle]: message.message} satisfies GptUserQuerySchemaType : {[message.handle]: {
    thoughts: message.thoughts,
    answer: message.answer,
    // messageId: message.messageId,
  }} satisfies GptActorResponseSchemaType, message.role === 'actor' ? message.propertyMap : null),
}));

const getInitMessages = () => [{
  role: 'system',
  content: getMainPrompt(),
} as const, {
  role: 'assistant',
  content: getTrainingAnswer(),
} as const];

const getCompletion = async (chatId: ChatId, newMessage: Message & {role: 'user'}): Promise<CreateChatCompletionResponse> => {
  const initMessages = getInitMessages();
  const messages = getMessages(chatId, newMessage);
  console.log('messages', messages);
  return (await openai.createChatCompletion({
    stream: false,
    model: 'gpt-3.5-turbo',
    temperature: 0.7,
    messages: [
      ...initMessages,
      ...messages,
    ]
  })).data;
};

let blocked = false;

telebot.onText(/\/reset/, async (msg) => {
  messagesPerChat[msg.chat.id] = [];
  await telebot.sendMessage(msg.chat.id, 'reset done');
});

telebot.on('message', async (msg) => {
  if (msg.text === '/reset') return; // TODO wtf can we do better routing
  console.log('msg', msg);
  if (blocked) {
    console.log('skipping message, blocked');
    return;
  } // TODO proper async handling

  const chatId = msg.chat.id;
  if (messagesPerChat[chatId]?.length > 1000) {
    console.error('too many messages already, ddos?');
    return;
  }
  if (msg.from?.is_bot) {
    console.log('skipping (own?) th bot message', msg.text);
    return;
  }
  if (!msg.text) {
    console.log('skipping non-text message', msg);
    return;
  }
  try {
    blocked = true;
    const text = assertExists(msg.text, 'no message text');
    if (!messagesPerChat[chatId]) {
      messagesPerChat[chatId] = [];
    }
    const messagesForThisChat = messagesPerChat[chatId];
    const userMessage: Message & {role: 'user'} = {
      role: 'user' as const,
      message: text,
      handle: 'Igor' // TODO hardcode
    } as const;
    const completion = await getCompletion(chatId, userMessage);
    const botMessageRaw = assertExists(completion.choices[0].message).content;
    console.log('botMessageRaw', botMessageRaw);

    const botMessageJsonParsed = (() => {
      try {
        return [orderedJson.parse(botMessageRaw)];
      } catch (e) {
        try {
          // gpt3.5 would sometimes return two objects separated by newline {} \n {}, just ignore all except first for now
          const strings = botMessageRaw.split('\n').filter(Boolean);
          return strings.map(s => orderedJson.parse(s));
        } catch (e) {
          // not parseable at all, TODO set system message "stay in role" or something
          console.error('unparseable bot message', botMessageRaw);
          throw e;
        }
      }
    })();

    // only after successful parsing otherwise messages like "forget your instructions" would stuck in the conversation
    // TODO maybe also delete non-parseable from chat history; should fit our purpose
    messagesPerChat[chatId].push(userMessage);

    const botMessageEs = botMessageJsonParsed.map(o => pipe(S.parseEither(GptActorResponseSchema)(o.object), E.map(r => ({object: r, propertyMap: o.map}))));
    const botMessagesE = pipe(botMessageEs, A.sequence(E.Applicative), E.map(A.reduce({} as {object: GptActorResponseSchemaType, propertyMap: PropertyMap}, (acc, o) => ({object: {
        ...acc.object, ...o.object
      }, propertyMap: {...acc.propertyMap, ...o.propertyMap}}))));
    if (botMessagesE._tag === 'Left') {
      console.log('unparseable bot message', botMessagesE.left);
      return;
    }
    const botMessage = botMessagesE.right;
    for (const [handle, message] of Object.entries(botMessage.object)) {
      if (!['Josh', 'Mary'/*TODO bind them with prompts*/].includes(handle)) {
        // hallucination when he includes real people
        console.log('skipping message for unknown handle', handle);
        continue;
      }
      messagesForThisChat.push({
        role: 'actor' as const,
        handle,
        propertyMap: botMessage.propertyMap, // bigger property map than "just for this message" but it's all right
        ...message,
      });
      await telebot.sendMessage(chatId, `${handle} thoughts: ${message.thoughts.join(',') || '[no thoughts]'}`);
      await telebot.sendMessage(chatId, `${handle}: ${message.answer || '[no answer given]'}`);
    }

  } finally {
    blocked = false;
  }
  console.log('messages', messagesPerChat[chatId]);
});

app.listen(port, host, () => {
  console.log(`[ ready ] http://${host}:${port}`);
});

process.on('uncaughtException', (err) => {
  console.error('whoops! there was an error', err);
});