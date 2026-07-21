/**
 * 单一版本源（Single Source of Truth）
 *
 * 安装包显示版本、artifactName、更新清单（latest.yml path）、
 * 关于页面（通过 app:version IPC）都从这里取版本号。
 *
 * 权威来源 = 本包 package.json 的 `version` 字段。
 * electron-builder 构建时自动读取 package.json.version 生成
 * artifactName（`${productName}-Setup-${version}.${ext}`）与 latest.yml，
 * 因此本模块仅作为运行时代码的统一读取入口，避免多处硬编码版本号。
 *
 * 升级路径：
 *   package.json.version  ──▶  electron-builder  ──▶  安装包文件名 / latest.yml.version
 *                       └─▶  app:version IPC  ──▶  关于页面
 */

import pkg from '../../package.json';

/** 应用版本号（语义化版本，如 "1.3.0"）。 */
export const APP_VERSION: string = pkg.version;

/** 产品显示名（与 electron-builder.yml 的 productName 保持一致）。 */
export const APP_PRODUCT: string = pkg.productName || '外贸系统';

/** 包名（用于日志/调试）。 */
export const APP_NAME: string = pkg.name || 'vaysen-crm-desktop';

/**
 * 将 "1.3.0" 解析为可比对的数字元组 [1,3,0]。
 * 供更新链 dry-run 等场景做旧版→新版大小比较。
 */
export function parseVersion(version: string): [number, number, number] {
  const parts = version.split('.').map((p) => parseInt(p, 10));
  return [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
  ];
}

/**
 * 判断 available 是否比 installed 更新（严格大于）。
 * 用于模拟 electron-updater 的「是否有可用更新」决策。
 */
export function isNewer(available: string, installed: string): boolean {
  const a = parseVersion(available);
  const b = parseVersion(installed);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}
