import express from 'express';
import openai, { tokenHash } from './openai/connection';
import { ChatCompletionRequestMessage } from 'openai/api';
import { getMainPrompt, getTrainingAnswer } from './prompts';
import * as S from "@effect/schema/Schema";
import telebot from './telegram/connection';
import { assertExists } from './utils';
import { CreateChatCompletionResponse } from 'openai';
import { ChatId } from 'node-telegram-bot-api';
import orderedJson from 'json-order';
import { PropertyMap } from 'json-order/dist/models';
import { flow, pipe } from 'fp-ts/function';
import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import * as E from 'fp-ts/Either';
import { PrismaClient, Message as DbMessage } from '@prisma/client'
import { Either } from 'fp-ts/Either';
import { ParseError } from '@effect/schema/ParseResult';

const prisma = new PrismaClient();

const host = process.env.HOST ?? 'localhost';
const port = process.env.PORT ? Number(process.env.PORT) : 3000;


const app = express();

type ReadonlyPropertyMap = {
  readonly [key: string]: readonly string[];
}

type Message = ({
  readonly role: 'user',
  readonly handle: string, // user handle type todo
  readonly message: string,
} | {
  readonly role: 'actor',
  readonly handle: string, // actor handle type todo
  readonly thoughts: readonly string[],
  // messageId?: string,
  readonly answer: string,
  readonly propertyMap: ReadonlyPropertyMap,
}) & {
  readonly role: Role
};

const GptActorResponseSchema = S.record(S.string, S.struct({
  thoughts: S.array(S.string),
  answer: S.string,
}));

type GptActorResponseSchemaType = S.To<typeof GptActorResponseSchema>;

const GptUserQuerySchema = S.record(S.string, S.string);

type GptUserQuerySchemaType = S.To<typeof GptUserQuerySchema>;

const UserLiteral = S.literal('user');

const ActorLiteral = S.literal('actor');

const RoleModel = S.union(
  UserLiteral,
  ActorLiteral
);

type Role = S.From<typeof RoleModel>;

const tgChatIdToDbChatId = (chatId: ChatId) => `${chatId}`;

const DbMessageSchema = S.union(S.struct({
  role: UserLiteral,
  handle: S.string, // TODO newtype
  message: S.string,
}), S.struct({
  role: ActorLiteral,
  handle: S.string, // TODO newtype
  thoughts: S.array(S.string),
  answer: S.string,
  propertyMap: S.record(S.string, S.array(S.string)),
}));

const parseDbMessage = S.parseEither(DbMessageSchema);

const getDbChatMessages = async (chatId: ChatId) => {
  const chat = await prisma.chat.findUnique({
    where: {
      chatId: tgChatIdToDbChatId(chatId)
    }
  });
  const {left: errors, right: messages} = pipe(chat,
    O.fromNullable,
    O.map(flow(c => c.messages, A.map(parseDbMessage))),
    O.getOrElse(() => [] as Either<ParseError, Message>[]),
    A.separate
  );
  // ignore errors here
  if (errors.length > 0) {
    console.warn('ignoring db message parse errors', JSON.stringify(errors, null, 2));
  }
  return messages;
};

const resetDbChatMessages = async (chatId: ChatId) => {
  await prisma.chat.upsert({
    where: {
      chatId: tgChatIdToDbChatId(chatId)
    },
    update: {
      messages: [],
    },
    create: {
      chatId: tgChatIdToDbChatId(chatId),
      messages: []
    }
  });
};

const pushDbChatMessage = async (chatId: ChatId, message: Message) => {
  await prisma.chat.upsert({
    where: {
      chatId: tgChatIdToDbChatId(chatId)
    },
    update: {
      messages: {
        push: message as DbMessage,
      },
    },
    create: {
      chatId: tgChatIdToDbChatId(chatId),
      messages: []
    }
  });
}

const getMessages = async (chatId: ChatId, newMessage: Message & {role: 'user'}): Promise<ChatCompletionRequestMessage[]> => (await getDbChatMessages(chatId)).concat([newMessage]).map((message) => ({
  role: message.role === 'user' ? 'user' : 'assistant',
  content: orderedJson.stringify(message.role === 'user' ? {[message.handle]: message.message} satisfies GptUserQuerySchemaType : {[message.handle]: {
    thoughts: message.thoughts,
    answer: message.answer,
    // messageId: message.messageId,
  }} satisfies GptActorResponseSchemaType, message.role === 'actor' ? message.propertyMap as PropertyMap : null),
}));

const getInitMessages = () => [{
  role: 'system',
  content: getMainPrompt(),
} as const, {
  role: 'assistant',
  content: getTrainingAnswer(),
} as const];

// chat_id varchar indexed
//

const createChatCompletion = async (chatId: ChatId, ...params: Parameters<typeof openai.createChatCompletion>): Promise<Awaited<ReturnType<typeof openai.createChatCompletion>>['data']> => {
  const completionIntentPromise = prisma.completion.create({
    data: {
      chatId: tgChatIdToDbChatId(chatId),
      state: 'intent',
      tokenHash: `${tokenHash}`,
      model: params[0].model,
    }
  });
  try {
    const completion = await openai.createChatCompletion(...params);
    const completionIntent = await completionIntentPromise;
    await prisma.completion.update({
      where: {
        id: completionIntent.id,
      },
      data: {
        state: 'done',
        promptTokens: completion.data.usage?.prompt_tokens,
        completionTokens: completion.data.usage?.completion_tokens,
      }
    })
    // report completion according to completionIntent
    return completion.data;
  } catch (e) {
    const completionIntent = await completionIntentPromise;
    try {
      await prisma.completion.update({
        where: {
          id: completionIntent.id,
        },
        data: {
          state: 'error',
        }
      });
    } catch (e) {
      console.error('failed to update completion intent state to erroneous, ignoring', e);
    }
    throw e;
  }
}

const getCompletion = async (chatId: ChatId, newMessage: Message & {role: 'user'}): Promise<CreateChatCompletionResponse> => {
  const initMessages = getInitMessages();
  const messages = await getMessages(chatId, newMessage);
  console.log('messages', messages);
  return (await createChatCompletion(chatId, {
    stream: false,
    // model: 'gpt-3.5-turbo',
    model: 'gpt-4', // available after I have one charge from openai
    temperature: 0.7,
    messages: [
      ...initMessages,
      ...messages,
    ]
  }));
};

let blocked = false;

telebot.onText(/\/reset/, async (msg) => {
  await resetDbChatMessages(msg.chat.id);
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
  const messagesForThisChat = await getDbChatMessages(chatId);
  if (messagesForThisChat.length > 1000) {
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
    await pushDbChatMessage(chatId, userMessage);

    const botMessageEs = botMessageJsonParsed.map(o => pipe(S.parseEither(GptActorResponseSchema)(o.object), E.map(r => ({object: r, propertyMap: o.map}))));
    const botMessagesE = pipe(botMessageEs, A.sequence(E.Applicative), E.map(A.reduce({} as {object: GptActorResponseSchemaType, propertyMap: PropertyMap}, (acc, o) => ({object: {
        ...acc.object,
        ...o.object
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

      await pushDbChatMessage(chatId, {
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
});

app.listen(port, host, () => {
  console.log(`[ ready ] http://${host}:${port}`);
});

process.on('uncaughtException', (err) => {
  console.error('whoops! there was an error', err);
});