import Telebot from 'node-telegram-bot-api';
import { TELEGRAM_TOKEN } from '../env';

const telebot = new Telebot(TELEGRAM_TOKEN, { polling: true })

export default telebot;