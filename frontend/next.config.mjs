/**
 * Next.js 双目标构建配置（TASK-110）
 *
 * 两个互斥目标，通过环境变量 NEXT_OUTPUT 切换：
 *   - web     (默认) → output: 'standalone'，供 Linux Web 容器使用，默认同源 /api
 *   - export  (Electron) → output: 'export' + images.unoptimized，静态产物输出到 out/
 *
 * 关键约束（来自 TASK-110 验收）：
 *   1. 禁止在源码/配置中硬编码私网 IP 或 localhost 作为 API 地址回退。
 *   2. Web 与局域网 Electron 模式默认同源 /api；Electron 主进程再代理到 ZeroTier 后端。
 *   3. 两个目标使用独立的 distDir，互不污染，保证构建顺序无关、可重现。
 *   4. 恢复 lint/typecheck/test 独立门禁（见 package.json scripts）。
 *
 * 历史遗留：此前固定使用 distDir '.next-fresh' 且 web 模式未启用 standalone，
 * 导致两个目标互相污染、Dockerfile 复制了不存在的 .next/standalone。已清理。
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateElectronApiUrl } from './scripts/electron-api-policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const OUTPUT_MODE = process.env.NEXT_OUTPUT || 'standalone';
if (!['standalone', 'export'].includes(OUTPUT_MODE)) {
  throw new Error(`[next.config] 未知 NEXT_OUTPUT=${OUTPUT_MODE}，只允许 standalone 或 export`);
}
const isStaticExport = OUTPUT_MODE === 'export';

const electronApiValidation = isStaticExport
  ? validateElectronApiUrl(process.env.NEXT_PUBLIC_API_URL || '/api')
  : null;

if (electronApiValidation && !electronApiValidation.ok) {
  throw new Error(`[next.config] Electron API 配置拒绝构建：${electronApiValidation.reason}`);
}

/**
 * Web 与局域网 Electron 默认同源 /api；高级部署仍可注入经批准的绝对地址。
 * 这里也重复 fail-closed，防止直接 NEXT_OUTPUT=export next build 绕过正式入口。
 */
const apiBaseUrl = isStaticExport ? electronApiValidation.normalizedUrl : '/api';

const nextConfig = {
  // 双目标隔离：
  //   - Web 使用独立 distDir '.next-web'，产出 standalone 到 .next-web/standalone
  //   - Electron 使用默认 distDir '.next'，静态导出落到约定目录 out/（再由 build:electron 复制到 electron-export/）
  // 两者互不污染，保证构建顺序无关、可重现
  distDir: isStaticExport ? '.next' : '.next-web',

  // 类型检查门禁：保持 Next 默认（build 期执行 tsc），不设置 typescript.ignoreDuringBuilds。
  // Lint 门禁保持 Next 默认 fail-closed。当前 src 遗留错误由 TASK-112 修复；
  // 在两分支集成前，本分支的完整 build 会如实被 lint 阻断，不再以 ignoreDuringBuilds 伪装全绿。

  ...(isStaticExport
    ? {
        // Electron 静态导出模式
        output: 'export',
        images: {
          unoptimized: true, // 静态导出不支持图片优化
        },
        // 静态导出时禁用 trailingSlash 以匹配 Electron 内 Express 回退
        trailingSlash: false,
        // 静态导出产物目录由 Next 固定为 out/，再由 build:electron 复制到 TASK-111 契约路径 electron-export/
      }
    : {
        // Web（Linux 容器）standalone 模式
        output: 'standalone',
      }),

  // 确保所有环境变量在构建时可用；API 地址由上述 apiBaseUrl 统一控制，杜绝硬编码私网 IP/localhost
  env: {
    NEXT_PUBLIC_API_URL: apiBaseUrl,
  },

  // 构建期将 src 中遗留的 localhost 回退字面量替换为受控 API 基地址，
  // 确保产物不含 localhost / 私网 IP（属于构建配置层，不改动 src 业务代码；TASK-112 应清理 src 源头）。
  webpack: (config) => {
    config.module.rules.push({
      test: /\.(ts|tsx|js|jsx|mjs)$/,
      enforce: 'pre',
      exclude: /node_modules/,
      use: [
        {
          loader: resolve(__dirname, 'scripts/strip-localhost-loader.cjs'),
          options: { replacement: apiBaseUrl },
        },
      ],
    });
    return config;
  },
};

export default nextConfig;
