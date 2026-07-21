import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const componentPath = process.argv[2];
if (!componentPath) {
  console.error('Usage: node scripts/generate-review-packet.mjs <component-path>');
  console.error('Example: node scripts/generate-review-packet.mjs src/components/auth/RegisterForm.tsx');
  process.exit(1);
}

const absPath = resolve(componentPath);
if (!existsSync(absPath)) {
  console.error(`File not found: ${absPath}`);
  process.exit(1);
}

const componentName = basename(absPath, '.tsx');
const componentDir = dirname(absPath);
const testPath = join(componentDir, '__tests__', `${componentName}.test.tsx`);

// Desensitization rules
function desensitize(text) {
  return text
    .replace(/https?:\/\/localhost:\d+/g, '<API_URL>')
    .replace(/https?:\/\/[a-zA-Z0-9.-]+\.(com|cn|net|org|io)/g, '<API_URL>')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<TOKEN>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <TOKEN>')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, 'user@example.com')
    .replace(/\+?\d{11,}/g, '+8613800138000')
    .replace(/(?:C:\\|D:\\|F:\\|\/home\/\w+\/|\/var\/)[^\s'"`)]+/g, '<PATH>')
    .replace(/postgresql:\/\/[^\s"')]+/g, 'postgresql://<DB_URL>')
    .replace(/redis:\/\/[^\s"')]+/g, 'redis://<DB_URL>');
}

async function tryRead(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function main() {
  const source = await readFile(absPath, 'utf8');
  const test = await tryRead(testPath);

  // Try to find contract and CRCP docs
  const docsRoot = resolve('docs/frontend-ai');
  const contract = await tryRead(join(docsRoot, 'contracts', `${componentName.toLowerCase().replace(/form$/, '-form')}.contract.md`));
  const crcp = await tryRead(join(docsRoot, 'prompts', `${componentName.toLowerCase().replace(/form$/, '-form')}.crcp.md`));

  // Count lines
  const loc = source.split('\n').length;

  const packet = `# AI Review Packet: ${componentName}

| 字段 | 值 |
|------|-----|
| 组件名称 | ${componentName} |
| 审查日期 | ${new Date().toISOString().slice(0, 10)} |
| 代码行数 | ${loc} |

---

## 组件契约

${contract ? desensitize(contract) : '（未找到契约文档）'}

---

## CRCP 提示词

${crcp ? desensitize(crcp) : '（未找到 CRCP 文档）'}

---

## 源代码（已脱敏）

\`\`\`tsx
${desensitize(source)}
\`\`\`

---

## 测试代码（已脱敏）

${test ? `\`\`\`tsx\n${desensitize(test)}\n\`\`\`` : '（未找到测试文件）'}

---

## 审查清单

请按 review-checklist.md 逐项检查，标注 ✅/⚠️/❌。

### P0 — 安全/数据丢失
- [ ] 无未净化的 dangerouslySetInnerHTML
- [ ] 无硬编码密钥/令牌
- [ ] 无用户输入直接拼入 URL/SQL
- [ ] 无敏感数据未加密存储
- [ ] 无 any 在安全关键路径

### P1 — 业务失败
- [ ] 所有 Promise 有 catch
- [ ] 表单验证覆盖必填字段
- [ ] 网络错误有用户反馈
- [ ] 竞态条件已处理
- [ ] 空/加载/错误状态均有渲染

### P2 — 可维护性/可访问性
- [ ] 组件职责单一
- [ ] useEffect 有清理函数
- [ ] 列表使用稳定 key
- [ ] aria 属性完整
- [ ] 键盘可操作

### P3 — 风格
- [ ] 命名清晰
- [ ] 无未使用导入
- [ ] 文件组织符合约定
`;

  const outputDir = join(docsRoot, 'review-packets');
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, `${componentName}-${new Date().toISOString().slice(0, 10)}.md`);
  await writeFile(outputPath, packet, 'utf8');
  console.log(`Review packet generated: ${outputPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
