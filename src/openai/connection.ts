import { Configuration, OpenAIApi } from 'openai';
import { OPENAI_SECRET } from '../env';
import { stringHashCode } from '../utils';

const configuration = new Configuration({
  apiKey: OPENAI_SECRET,
});

export const tokenHash = stringHashCode(OPENAI_SECRET);

const openai = new OpenAIApi(configuration);

export default openai;