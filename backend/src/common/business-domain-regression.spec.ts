import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Example Trading Company production-domain regression', () => {
  const productionBusinessFiles = [
    'src/modules/continuous-prospect/continuous-prospect.service.ts',
    'src/modules/search/prospect-categories.ts',
    'src/modules/search/search.service.ts',
    'src/modules/leads/leads.service.ts',
    '../tools/deep-research-cli.js',
    '../scripts/launch-acquisition.mjs',
    'src/modules/deep-research/report-template.ts',
    '../workflows/ai-lead-scoring-test.json',
    '../scripts/start-local.ps1',
  ];

  it.each(productionBusinessFiles)('%s contains no legacy eyewear business default', (file) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');
    expect(source).not.toMatch(/jingseyewear|opulent[_\s-]*gaze|sun\s*glasses?|eye\s*wear|镜雅|眼镜|太阳镜/i);
  });

  it('keeps packaging buyer signals in every prospecting layer', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/modules/search/prospect-categories.ts'),
      'utf8',
    );
    expect(source).toMatch(/poly mailer/i);
    expect(source).toMatch(/kraft paper bag/i);
    expect(source).toMatch(/garbage bag/i);
    expect(source).toMatch(/ziplock/i);
    expect(source).toMatch(/Packaging Distributors/i);
  });
});
