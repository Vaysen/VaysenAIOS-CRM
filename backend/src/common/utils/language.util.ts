/**
 * Language Utility
 *
 * Shared helpers for mapping ISO 639-1 language codes to display names
 * and resolving the target language for AI-generated customer communications.
 */

/** Supported target languages mapped to their display names. */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  zh: 'Chinese',
  'zh-CN': 'Chinese',
};

/** Default fallback language when AI call fails or language is unknown. */
export const DEFAULT_FALLBACK_LANGUAGE = 'en';

/**
 * Resolve the display name for a language code.
 * Falls back to English when the code is unknown.
 */
export function getLanguageName(language?: string | null): string {
  if (!language) return LANGUAGE_NAMES[DEFAULT_FALLBACK_LANGUAGE];
  return LANGUAGE_NAMES[language] || LANGUAGE_NAMES[DEFAULT_FALLBACK_LANGUAGE];
}

/**
 * Normalize a language code to a supported value.
 * Returns 'en' for unknown / missing values.
 */
export function normalizeLanguage(language?: string | null): string {
  if (!language) return DEFAULT_FALLBACK_LANGUAGE;
  const lower = language.toLowerCase();
  if (LANGUAGE_NAMES[lower]) return lower;
  if (lower.startsWith('zh')) return 'zh';
  return DEFAULT_FALLBACK_LANGUAGE;
}
