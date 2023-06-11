import { assertExists } from '../utils';

export const OPENAI_SECRET = assertExists(process.env.OPENAI_SECRET, 'OPENAI_SECRET is not deqfined');
export const TELEGRAM_TOKEN = assertExists(process.env.TELEGRAM_TOKEN, 'TELEGRAM_TOKEN is not defined');