import { ApiError } from '../../common/http/api-error';
import enUS from './locale/en-US.json';
import viVN from './locale/vi-VN.json';

const COPY: Record<string, Record<string, string>> = { 'vi-VN': viVN, 'en-US': enUS };

// Fail closed: a missing locale must never fall back to another language silently (§2.5).
export function copyFor(locale: string, key: string) {
  const text = COPY[locale]?.[key];
  if (!text) throw new ApiError('CONTENT_UNAVAILABLE', `Missing copy ${key} for ${locale}`);
  return text;
}

export const hasLocaleCopy = (locale: string) => locale in COPY;
