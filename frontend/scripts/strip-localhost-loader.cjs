// TASK-110：构建期字符串替换 loader（属于构建配置层，不改动 src 业务代码）
// 将遗留的 localhost 回退字面量（http://localhost:4000[/api]）替换为受控的 API 基地址，
// 确保产物中不包含 localhost / 私网 IP（验收项：构建产物不包含 localhost）。
// 注入的具体地址由 next.config.mjs 通过 options.replacement 传入：
//   - web     → '/api'（同源）
//   - electron → 构建参数 NEXT_PUBLIC_API_URL（未注入则为空，由 TASK-111 运行时注入）
module.exports = function stripLocalhostLoader(source) {
  const replacement =
    this.query && this.query.replacement != null ? this.query.replacement : '';
  return source
    .split('http://localhost:4000/api')
    .join(replacement)
    .split('http://localhost:4000')
    .join(replacement);
};
