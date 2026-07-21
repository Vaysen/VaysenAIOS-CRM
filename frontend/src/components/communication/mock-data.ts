import type { ConversationSummary, ConversationDetail, CommunicationMessage } from './types';

const now = new Date();
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60000).toISOString();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600000).toISOString();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();

export const mockConversations: ConversationSummary[] = [
  {
    id: 'conv-1',
    channel: 'website_inquiry',
    subject: 'Custom printed poly mailers 10,000 pcs',
    status: 'active',
    lastMessageAt: minutesAgo(3),
    lastMessagePreview: 'Hi, we are a cosmetics brand looking for custom printed poly mailers. Can you do full-color printing with our logo?',
    unreadCount: 2,
    lead: { id: 'lead-1', companyName: 'Glow Beauty Inc.', contactName: 'Jessica Miller', country: 'USA', language: 'en' },
    assignedUser: { id: 'u1', firstName: '茶茶', lastName: '' },
  },
  {
    id: 'conv-2',
    channel: 'business_email',
    subject: 'Re: Kraft paper bags quote request',
    status: 'active',
    lastMessageAt: hoursAgo(1),
    lastMessagePreview: 'Thanks for the quote. We need the 200gsm kraft paper with twisted handles. When can you ship?',
    unreadCount: 0,
    lead: { id: 'lead-2', companyName: 'EcoPackage Ltd.', contactName: 'Thomas Berg', country: 'Germany', language: 'de' },
    assignedUser: { id: 'u1', firstName: '茶茶', lastName: '' },
  },
  {
    id: 'conv-3',
    channel: 'whatsapp',
    subject: null,
    status: 'active',
    lastMessageAt: hoursAgo(3),
    lastMessagePreview: 'Hola, tienen bolsas para basura biodegradables?',
    unreadCount: 1,
    lead: { id: 'lead-3', companyName: 'Distribuidora Verde SA', contactName: 'Carlos Ruiz', country: 'Mexico', language: 'es' },
    assignedUser: { id: 'u1', firstName: '茶茶', lastName: '' },
  },
  {
    id: 'conv-4',
    channel: 'marketing_email',
    subject: 'Packaging solutions for your bakery chain',
    status: 'active',
    lastMessageAt: hoursAgo(5),
    lastMessagePreview: null,
    unreadCount: 0,
    lead: { id: 'lead-4', companyName: 'SweetBake Bakeries', contactName: 'Anna Kowalski', country: 'Poland', language: 'en' },
    assignedUser: null,
  },
  {
    id: 'conv-5',
    channel: 'business_email',
    subject: 'Re: Re: Self-seal bags sample request',
    status: 'active',
    lastMessageAt: hoursAgo(7),
    lastMessagePreview: 'I received the samples, quality looks good. Let me discuss with my team and get back to you.',
    unreadCount: 0,
    lead: { id: 'lead-5', companyName: 'PackRight Supplies', contactName: 'David Chen', country: 'Australia', language: 'en' },
    assignedUser: { id: 'u1', firstName: '茶茶', lastName: '' },
  },
  {
    id: 'conv-6',
    channel: 'website_inquiry',
    subject: 'Trash bag wholesale inquiry',
    status: 'archived',
    lastMessageAt: daysAgo(2),
    lastMessagePreview: 'Do you have MOQ for small orders? We want to test the market first.',
    unreadCount: 0,
    lead: { id: 'lead-6', companyName: 'CleanPro Services', contactName: 'Maria Silva', country: 'Brazil', language: 'en' },
    assignedUser: null,
  },
];

export function getMockConversationDetail(id: string): ConversationDetail | null {
  const conv = mockConversations.find((c) => c.id === id);
  if (!conv) return null;

  const messages: CommunicationMessage[] = [
    {
      id: 'msg-1',
      direction: 'inbound',
      content: conv.lastMessagePreview || 'Initial inquiry message.',
      contentType: 'text',
      fromAddress: conv.lead?.contactName?.toLowerCase().replace(' ', '.') + '@example.com' || 'contact@example.com',
      toAddress: 'info@example.com',
      subject: conv.subject,
      sentAt: null,
      receivedAt: conv.lastMessageAt,
      attachmentsMeta: null,
      createdAt: conv.lastMessageAt || now.toISOString(),
    },
    {
      id: 'msg-2',
      direction: 'outbound',
      content: 'Thank you for reaching out! We can definitely help with your requirements. Let me prepare a detailed quote for you.',
      contentType: 'text',
      fromAddress: 'info@example.com',
      toAddress: conv.lead?.contactName?.toLowerCase().replace(' ', '.') + '@example.com' || 'contact@example.com',
      subject: conv.subject ? 'Re: ' + conv.subject : null,
      sentAt: conv.lastMessageAt,
      receivedAt: null,
      attachmentsMeta: null,
      createdAt: conv.lastMessageAt || now.toISOString(),
    },
  ];

  return {
    ...conv,
    contactPoint: { id: 'cp-1', type: 'email', normalizedValue: conv.lead?.contactName?.toLowerCase().replace(' ', '.') + '@example.com' },
    messages,
    aiArtifacts: [],
  };
}
