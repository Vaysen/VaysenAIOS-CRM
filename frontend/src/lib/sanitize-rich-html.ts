import sanitizeHtml from 'sanitize-html';

const SAFE_STYLE_VALUE = /^(?!.*(?:url\s*\(|expression\s*\(|javascript:|data:|@import)).*$/i;

/**
 * Strict sanitizer for any HTML originating from email, AI, the database, or
 * another user. It deliberately excludes active content and event handlers so
 * Electron's privileged preload can never be reached through stored HTML.
 */
export function sanitizeRichHtml(html: unknown): string {
  if (typeof html !== 'string' || !html) return '';
  return sanitizeHtml(html, {
    allowedTags: [
      'a', 'b', 'i', 'strong', 'em', 'u', 's', 'strike', 'br', 'p', 'div', 'span',
      'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'blockquote', 'pre', 'code',
      'font', 'center', 'sub', 'sup', 'dl', 'dt', 'dd',
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel', 'class', 'style'],
      img: ['src', 'alt', 'width', 'height', 'class', 'style'],
      table: ['border', 'cellpadding', 'cellspacing', 'width', 'class', 'style'],
      td: ['colspan', 'rowspan', 'width', 'class', 'style'],
      th: ['colspan', 'rowspan', 'width', 'class', 'style'],
      div: ['align', 'class', 'style'],
      p: ['align', 'class', 'style'],
      span: ['class', 'style'],
      font: ['color', 'size', 'face'],
      '*': ['class', 'align'],
    },
    allowedStyles: {
      '*': {
        color: [SAFE_STYLE_VALUE],
        'background-color': [SAFE_STYLE_VALUE],
        'font-size': [SAFE_STYLE_VALUE],
        'font-family': [SAFE_STYLE_VALUE],
        'font-weight': [SAFE_STYLE_VALUE],
        'font-style': [SAFE_STYLE_VALUE],
        'text-align': [SAFE_STYLE_VALUE],
        'text-decoration': [SAFE_STYLE_VALUE],
        margin: [SAFE_STYLE_VALUE],
        padding: [SAFE_STYLE_VALUE],
        border: [SAFE_STYLE_VALUE],
        width: [SAFE_STYLE_VALUE],
        height: [SAFE_STYLE_VALUE],
        'line-height': [SAFE_STYLE_VALUE],
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    enforceHtmlBoundary: true,
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: 'a',
        attribs: { ...attribs, rel: 'noopener noreferrer' },
      }),
    },
  });
}
