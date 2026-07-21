/**
 * Jest 测试配置
 *
 * 使用 ts-jest preset 在 Node 环境中运行 TypeScript 测试
 * 模块路径别名与 tsconfig.json 保持一致
 */

/** @type {import('jest').Config} */
module.exports = {
  // 使用 ts-jest preset 编译 TypeScript
  preset: 'ts-jest',

  // 测试运行环境：Node.js（主进程测试不需要浏览器 DOM）
  testEnvironment: 'node',

  // 测试文件匹配规则
  testMatch: [
    '**/test/**/*.spec.ts',
  ],

  // 模块文件扩展名
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],

  // 模块路径别名（与 tsconfig.json paths 对齐）
  moduleNameMapper: {
    '^@main/(.*)$': '<rootDir>/src/main/$1',
    '^@preload/(.*)$': '<rootDir>/src/preload/$1',
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
  },

  // TypeScript 编译选项（覆盖 tsconfig 以兼容 Jest）
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'node',
        esModuleInterop: true,
        resolveJsonModule: true,
        strict: true,
        skipLibCheck: true,
        paths: {
          '@main/*': ['src/main/*'],
          '@preload/*': ['src/preload/*'],
          '@shared/*': ['src/shared/*'],
        },
      },
    }],
  },

  // 全局 setup 文件（启动 mock 服务器等）
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],

  // 覆盖率收集配置
  // 受审阅的分级阈值（TASK-111 item 7）：保留覆盖率门禁，不禁用（不使用 --coverage=false）。
  // 排除项均为「必须在真实 Electron / Chromium 运行时才能加载」的模块，无法在 Node 单测中执行：
  //   - app.ts / auto-updater.ts / tray.ts：依赖 app 就绪、electron-updater、Tray 原生 API
  //   - wa-preload.ts / app-preload.ts：依赖完整 WhatsApp Web DOM（Chromium），已在 wa-logic.ts
  //     抽取纯逻辑并由 preload-logic.spec.ts 行为覆盖（~98%）
  // ipc-handlers.ts 因需在 app ready 后注册 ipcMain.handle（依赖 Electron 主循环），
  // 仅以受审阅的低阈值纳入；其余可单测模块维持较高阈值。
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/main/app.ts',
    '!src/main/auto-updater.ts',
    '!src/main/tray.ts',
    '!src/preload/wa-preload.ts',
    '!src/preload/app-preload.ts',
  ],
  // TASK-111 v1.2 红线 6 复审修复：JEST_COVERAGE_DIR 环境变量优先于默认 'coverage'，
  // 允许 verify-baseline.mjs 把覆盖率报告写到系统临时目录（仓库零写承诺）。
  coverageDirectory: process.env.JEST_COVERAGE_DIR || 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'clover'],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 60,
      lines: 60,
      statements: 60,
    },
    './src/main/ipc-handlers.ts': {
      branches: 5,
      functions: 5,
      lines: 10,
      statements: 10,
    },
  },

  // 测试超时（毫秒）
  testTimeout: 15000,

  // 清除 mock 调用记录
  clearMocks: true,
  resetMocks: false,

  // 详细输出
  verbose: true,
};
