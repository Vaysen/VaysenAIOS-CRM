/**
 * 注册表单值类型 (FF-005 规格返工)
 *
 * 五字段：username / password / firstName / lastName / 可空 companyName
 * 组件本身无 API/router/store 依赖，由 adapter 层负责对接后端。
 */
export interface RegistrationValues {
  /** 用户名，至少 3 个字符 */
  username: string;
  /** 密码，至少 6 个字符 */
  password: string;
  /** 名，必填 */
  firstName: string;
  /** 姓，必填 */
  lastName: string;
  /** 公司名称，可选 */
  companyName?: string;
}

/** 字段级 + 提交级错误 */
export interface RegistrationErrors {
  username?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  submit?: string;
}

/** 单字段校验函数签名 */
export type FieldValidator = (
  field: keyof RegistrationValues,
  value: string,
) => string | undefined;
