/** @type {import('stylelint').Config} */
module.exports = {
  extends: ['stylelint-config-standard'],
  rules: {
    'at-rule-no-unknown': [
      true,
      {
        ignoreAtRules: ['tailwind', 'apply', 'variants', 'responsive', 'screen', 'layer'],
      },
    ],
    'no-descending-specificity': null,
    'selector-class-pattern': null,
  },
};
