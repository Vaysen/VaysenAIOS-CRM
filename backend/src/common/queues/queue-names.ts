export const QUEUES = {
  emailCompose: 'email-compose',
  emailValidate: 'email-validate',
  emailSend: 'email-send',
  prospectSearch: 'prospect-search',
  deepResearch: 'deep-research',
  maintenance: 'maintenance',
  // R111 批次C：营销活动投放执行队列（channel=whatsapp 时由 worker-marketing-delivery 消费）
  marketingDelivery: 'marketing-delivery',
} as const;
