#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const rcedit = require('rcedit');

/**
 * Apply Windows resources without electron-builder's winCodeSign downloader.
 * rcedit 4.0.1 is lock-file installed and supports the project's Node 20
 * contract. This hook runs before NSIS packages the unpacked application.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const appInfo = context.packager.appInfo;
  const executableName = context.packager.platformSpecificBuildOptions.executableName
    || appInfo.productFilename;
  const executable = path.join(context.appOutDir, `${executableName}.exe`);
  const icon = path.resolve(__dirname, '..', 'build', 'icon.ico');

  for (const file of [executable, icon]) {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      throw new Error(`[after-pack-rcedit] required release input is missing: ${file}`);
    }
  }

  await rcedit(executable, {
    'version-string': {
      FileDescription: 'Vaysen AI CRM 示例贸易公司局域网外贸业务桌面客户端',
      ProductName: 'Vaysen AI CRM',
      InternalName: executableName,
      OriginalFilename: `${executableName}.exe`,
      CompanyName: 'Example Trading Company',
      LegalCopyright: 'Copyright © 2026 Example Trading Company',
    },
    'file-version': appInfo.version,
    'product-version': appInfo.version,
    icon,
  });

  console.log(`[after-pack-rcedit] branded ${path.basename(executable)} ${appInfo.version}`);
};
