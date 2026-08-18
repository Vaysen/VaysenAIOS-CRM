# 当前安装入口

`installer/` 保存的是历史开发机安装脚本，依赖旧品牌、旧运行方式和旧凭据模型，现已全部停用并在入口处 fail-closed。

- Windows 客户端：使用 `release/Vaysen 外贸系统-Setup-1.3.2.exe`。
- Linux 后端：使用仓库根 `deploy.sh`，并按 `docs/LINUX_DEPLOYMENT.md` 从不可变 annotated tag 部署。
- 数据恢复：仅使用 `scripts/restore-db.sh` 与 `scripts/restore-runtime-data.sh`，且必须先校验备份。

旧脚本不进入 Electron NSIS 安装包，也不是当前 Linux Compose 发布链的一部分。
