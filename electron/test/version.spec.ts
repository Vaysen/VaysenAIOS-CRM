/**
 * version.ts 单元测试（TASK-111 单一版本源）
 *
 * 验证：
 * - 版本号 / 产品名从 package.json 正确读取
 * - parseVersion 解析为可比对的数字元组（含非法输入兜底）
 * - isNewer 严格大于判断（更新链决策）
 */

import {
  APP_VERSION,
  APP_PRODUCT,
  APP_NAME,
  parseVersion,
  isNewer,
} from '../src/shared/version';
import pkg from '../package.json';

describe('version.ts 单一版本源', () => {
  it('APP_VERSION 应与 package.json 的 version 一致', () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('APP_PRODUCT 应回退到 package.json 的 productName', () => {
    expect(APP_PRODUCT).toBe('Vaysen AI CRM');
  });

  it('APP_NAME 应回退到 package.json 的 name', () => {
    expect(APP_NAME).toBe('vaysen-crm-desktop');
  });

  describe('parseVersion', () => {
    it('解析标准语义化版本为 [major,minor,patch]', () => {
      expect(parseVersion('1.3.0')).toEqual([1, 3, 0]);
    });

    it('缺失段兜底为 0', () => {
      expect(parseVersion('2')).toEqual([2, 0, 0]);
    });

    it('非数字段兜底为 0', () => {
      expect(parseVersion('x.y.z')).toEqual([0, 0, 0]);
    });
  });

  describe('isNewer', () => {
    it('available 大于 installed 时返回 true', () => {
      expect(isNewer('1.4.0', '1.3.0')).toBe(true);
    });

    it('跨 minor 版本也可判定', () => {
      expect(isNewer('2.0.0', '1.9.9')).toBe(true);
    });

    it('相同版本返回 false', () => {
      expect(isNewer('1.3.0', '1.3.0')).toBe(false);
    });

    it('available 小于 installed 返回 false', () => {
      expect(isNewer('1.2.0', '1.3.0')).toBe(false);
    });
  });
});
