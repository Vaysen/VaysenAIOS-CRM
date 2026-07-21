/**
 * LanguageService — 客户语言自动识别服务
 *
 * 组合策略：
 * 1. 优先根据 Lead 的 country 字段映射语言
 * 2. 如果 country 无法映射或不存在，用 AI 分析消息内容
 * 3. 默认 fallback 为 'en'
 */
import { Injectable, Logger } from '@nestjs/common';
import { AiProviderService } from '../ai/ai-provider.service';

/** ISO 639-1 → 语言名称映射 */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  zh: '中文',
  'zh-CN': '中文',
};

/** 支持的语言代码列表 */
export const SUPPORTED_LANGUAGES = ['en', 'ja', 'ko', 'es', 'fr', 'de', 'it', 'zh', 'zh-CN'];

/**
 * 国家 → 语言映射表
 * key: 国家名称（英文，大小写不敏感）或 ISO 3166-1 alpha-2 代码
 */
const COUNTRY_LANGUAGE_MAP: Record<string, string> = {
  // 英语
  'us': 'en', 'usa': 'en', 'united states': 'en', 'united states of america': 'en',
  'uk': 'en', 'gb': 'en', 'united kingdom': 'en', 'britain': 'en', 'england': 'en',
  'au': 'en', 'australia': 'en',
  'ca': 'en', 'canada': 'en',
  'in': 'en', 'india': 'en',
  'sg': 'en', 'singapore': 'en',
  'ng': 'en', 'nigeria': 'en',
  'za': 'en', 'south africa': 'en',
  'nz': 'en', 'new zealand': 'en',
  'ie': 'en', 'ireland': 'en',
  'ph': 'en', 'philippines': 'en',
  'pk': 'en', 'pakistan': 'en',
  'bd': 'en', 'bangladesh': 'en',
  'eg': 'en', 'egypt': 'en', // 埃及商务沟通也常用英语
  'ae': 'en', 'united arab emirates': 'en', 'uae': 'en', // 阿联酋商务沟通常用英语
  'ke': 'en', 'kenya': 'en',
  'gh': 'en', 'ghana': 'en',

  // 日语
  'jp': 'ja', 'japan': 'ja',

  // 韩语
  'kr': 'ko', 'south korea': 'ko', 'korea': 'ko', 'republic of korea': 'ko',

  // 西班牙语
  'es': 'es', 'spain': 'en', 'españa': 'en', // 西班牙本身常用英语商务沟通
  'mx': 'es', 'mexico': 'es', 'méxico': 'es',
  'ar': 'es', 'argentina': 'es',
  'co': 'es', 'colombia': 'es',
  'cl': 'es', 'chile': 'es',
  'pe': 'es', 'peru': 'es', 'perú': 'es',
  've': 'es', 'venezuela': 'es',
  'ec': 'es', 'ecuador': 'es',
  'gt': 'es', 'guatemala': 'es',
  'cu': 'es', 'cuba': 'es',
  'bo': 'es', 'bolivia': 'es',
  'do': 'es', 'dominican republic': 'es',
  'py': 'es', 'paraguay': 'es',
  'sv': 'es', 'el salvador': 'es',
  'hn': 'es', 'honduras': 'es',
  'ni': 'es', 'nicaragua': 'es',
  'cr': 'es', 'costa rica': 'es',
  'pa': 'es', 'panama': 'es', 'panamá': 'es',
  'uy': 'es', 'uruguay': 'es',
  'pr': 'es', 'puerto rico': 'es',

  // 法语
  'fr': 'fr', 'france': 'fr',
  'be': 'fr', 'belgium': 'fr', // 比利时部分法语
  'ch': 'de', 'switzerland': 'de', // 瑞士主要德语
  'lu': 'fr', 'luxembourg': 'fr',
  'mc': 'fr', 'monaco': 'fr',
  'ht': 'fr', 'haiti': 'fr',
  'mg': 'fr', 'madagascar': 'fr',
  'sn': 'fr', 'senegal': 'fr',
  'ci': 'fr', "ivory coast": 'fr', "côte d'ivoire": 'fr',
  'cm': 'fr', 'cameroon': 'fr',
  'ml': 'fr', 'mali': 'fr',
  'bf': 'fr', 'burkina faso': 'fr',
  'ne': 'fr', 'niger': 'fr',
  'cg': 'fr', 'congo': 'fr',
  'ga': 'fr', 'gabon': 'fr',
  'bj': 'fr', 'benin': 'fr',
  'tg': 'fr', 'togo': 'fr',
  'cf': 'fr', 'central african republic': 'fr',
  'td': 'fr', 'chad': 'fr',
  'gn': 'fr', 'guinea': 'fr',
  'bi': 'fr', 'burundi': 'fr',
  'rw': 'fr', 'rwanda': 'fr',
  'dj': 'fr', 'djibouti': 'fr',

  // 德语
  'de': 'de', 'germany': 'de', 'deutschland': 'de',
  'at': 'de', 'austria': 'de', 'österreich': 'de',
  'li': 'de', 'liechtenstein': 'de',

  // 意大利语
  'it': 'it', 'italy': 'it', 'italia': 'it',
  'sm': 'it', 'san marino': 'it',
  'va': 'it', 'vatican city': 'it',

  // 中文
  'cn': 'zh', 'china': 'zh',
  'tw': 'zh', 'taiwan': 'zh',
  'hk': 'zh', 'hong kong': 'zh',
  'mo': 'zh', 'macau': 'zh',
};

@Injectable()
export class LanguageService {
  private readonly logger = new Logger(LanguageService.name);

  constructor(private aiProvider: AiProviderService) {}

  /**
   * 根据国家名称或代码推断语言
   * @param country 国家名称（英文或中文）或 ISO 3166-1 alpha-2 代码
   * @returns ISO 639-1 语言代码，无法识别时返回 null
   */
  detectByCountry(country: string | null | undefined): string | null {
    if (!country) return null;
    const normalized = country.trim().toLowerCase();

    // 直接查映射表
    if (COUNTRY_LANGUAGE_MAP[normalized]) {
      return COUNTRY_LANGUAGE_MAP[normalized];
    }

    // 尝试中文国家名 → 英文映射
    const chineseToCode: Record<string, string> = {
      '美国': 'us', '英国': 'gb', '日本': 'jp', '韩国': 'kr', '德国': 'de',
      '法国': 'fr', '西班牙': 'es', '意大利': 'it', '加拿大': 'ca',
      '澳大利亚': 'au', '印度': 'in', '新加坡': 'sg', '墨西哥': 'mx',
      '阿根廷': 'ar', '巴西': 'en', // 巴西用英语商务沟通
      '中国': 'cn', '台湾': 'tw', '香港': 'hk',
    };
    const code = chineseToCode[normalized];
    if (code && COUNTRY_LANGUAGE_MAP[code]) {
      return COUNTRY_LANGUAGE_MAP[code];
    }

    return null;
  }

  /**
   * 用 AI 分析文本内容判断语言
   * @param text 待分析的文本（邮件正文、消息内容等）
   * @returns ISO 639-1 语言代码
   */
  async detectByContent(text: string): Promise<string> {
    if (!text || text.trim().length < 10) return 'en';

    // 快速正则检测：中文、日文、韩文
    if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
    if (/[\u3040-\u30ff]/.test(text)) return 'ja'; // 平假名+片假名
    if (/[\uac00-\ud7af]/.test(text)) return 'ko'; // 韩文音节

    // 西里尔字母 → 俄语，但不在支持列表中，fallback en
    if (/[\u0400-\u04ff]/.test(text)) return 'en';

    // 阿拉伯字母 → 阿拉伯语，但不在支持列表中，fallback en
    if (/[\u0600-\u06ff]/.test(text)) return 'en';

    // 拉丁字母语言需要 AI 判断（en/es/fr/de/it）
    try {
      const result = await this.aiProvider.chat(
        'You are a language detection expert. Analyze the text and return ONLY the ISO 639-1 language code. Supported codes: en, ja, ko, es, fr, de, it, zh. If unsure, return "en".',
        `Detect the language of this text:\n\n${text.substring(0, 500)}`,
        { task: 'general' },
      );
      const code = result.content.trim().toLowerCase().substring(0, 5);
      if (SUPPORTED_LANGUAGES.includes(code)) {
        return code === 'zh-CN' ? 'zh' : code;
      }
      return 'en';
    } catch (err: any) {
      this.logger.warn(`AI language detection failed: ${err?.message}, defaulting to 'en'`);
      return 'en';
    }
  }

  /**
   * 组合策略：先根据 country 映射，再用 AI 内容分析校验
   * @param opts.country 国家名称或代码
   * @param opts.messageText 消息文本内容（用于 AI 校验）
   * @returns ISO 639-1 语言代码
   */
  async detectLanguage(opts: {
    country?: string | null;
    messageText?: string | null;
  }): Promise<string> {
    // 1. 先尝试 country 映射
    if (opts.country) {
      const lang = this.detectByCountry(opts.country);
      if (lang) {
        this.logger.debug(`Language detected by country "${opts.country}": ${lang}`);
        return lang;
      }
    }

    // 2. 再用 AI 内容分析
    if (opts.messageText) {
      const lang = await this.detectByContent(opts.messageText);
      this.logger.debug(`Language detected by content analysis: ${lang}`);
      return lang;
    }

    // 3. 默认英语
    return 'en';
  }

  /**
   * 获取语言显示名称
   */
  getLanguageName(code: string): string {
    return LANGUAGE_NAMES[code] || LANGUAGE_NAMES['en'];
  }
}
