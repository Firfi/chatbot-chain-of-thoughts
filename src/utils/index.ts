import isNil from 'lodash/isNil';

export const assertExists = <T>(x: T | null | undefined, msg?: string): T => {
  if (isNonExistent(x)) {
    throw new Error(msg || 'Expected value to be defined');
  }
  return x;
};

export const isNonExistent = <T>(x: T | null | undefined): x is null | undefined => !isExistent(x);

export const isExistent = <T>(x: T | null | undefined): x is T => !isNil(x);

export function stringHashCode(s: string): number {
  let hash = 0;
  let chr: number;

  if (s.length === 0) return hash;

  for (let i = 0; i < s.length; i++) {
    chr = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }

  return hash;
}