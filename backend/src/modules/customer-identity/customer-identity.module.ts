/**
 * TASK-102C / TASK-102E / TASK-102F: 客户身份解析模块
 *
 * 导出 IdentityResolutionService + EmailIdentityAdapter + CustomerMergeService 供
 * WhatsApp / email / communications / CRM 等渠道调用方使用。
 *
 * TASK-102E: 设为 @Global — EmailIdentityAdapter 需注入到 EmailsService, 而 EmailsModule
 * 不在本任务可修改文件清单内; 全局化使适配器在所有模块可注入 (与 PrismaModule 同为跨切面共享层)。
 * PrismaModule 是全局模块, PrismaService 直接注入, 无需在此 import。
 *
 * TASK-102F: CustomerMergeService 依赖全局 PrismaService, 一并注册并导出,
 * 供 CRM 合并/撤销/拒绝流程注入。
 */
import { Global, Module } from '@nestjs/common';
import { IdentityResolutionService } from './identity-resolution.service';
import { EmailIdentityAdapter } from './email-identity.adapter';
import { CustomerMergeService } from './customer-merge.service';

@Global()
@Module({
  providers: [IdentityResolutionService, EmailIdentityAdapter, CustomerMergeService],
  exports: [IdentityResolutionService, EmailIdentityAdapter, CustomerMergeService],
})
export class CustomerIdentityModule {}
