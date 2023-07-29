import Telebot, { ChatId } from 'node-telegram-bot-api';
import { v4 } from 'uuid';
import { TELEGRAM_TOKEN } from '../env';

const telebot = new Telebot(TELEGRAM_TOKEN, { polling: true });

type BotMessageSubscriptionHandle = string;
type BotMessageSubscriptionCallback = (chatId: ChatId, handle: string, message: string, isDebug?: boolean) => void;

const botMessageSubscriptions = new Map<BotMessageSubscriptionHandle, BotMessageSubscriptionCallback>

export const subscribeBotMessage = (cb: BotMessageSubscriptionCallback) => {
  const handle = v4();
  botMessageSubscriptions.set(handle, cb);
  return () => {
    botMessageSubscriptions.delete(handle);
  };
};

// messages from the bots
export const sendMessage = async (chatId: ChatId, handle: string, message: string, isDebug = false) => {
  botMessageSubscriptions.forEach((cb) => cb(chatId, handle, message, isDebug));
  await telebot.sendMessage(chatId, `${handle}: ${message}`);
};

// control messages?
export const onMessage = (callback: (msg: Telebot.Message) => void) => {
  telebot.on('message', callback);
};