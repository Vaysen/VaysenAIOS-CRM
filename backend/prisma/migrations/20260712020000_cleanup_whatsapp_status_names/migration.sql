-- 清理历史版本把 WhatsApp “最后上线于…”等 UI 状态写入客户名/会话标题的数据。
-- 仅处理已有关联 WhatsApp 会话的 Lead，并逐字段判断；不猜测真实姓名、不自动合并客户。

UPDATE "Lead" AS lead
SET
  "companyName" = CASE
    WHEN LOWER(BTRIM(COALESCE(lead."companyName", ''))) IN
      ('在线', 'online', 'unavailable', '业务账户', 'business account')
      OR LOWER(BTRIM(COALESCE(lead."companyName", ''))) LIKE '最后上线于%'
      OR LOWER(BTRIM(COALESCE(lead."companyName", ''))) LIKE 'last seen%'
      OR LOWER(BTRIM(COALESCE(lead."companyName", ''))) LIKE '正在输入%'
      OR LOWER(BTRIM(COALESCE(lead."companyName", ''))) LIKE 'typing%'
      OR LOWER(BTRIM(COALESCE(lead."companyName", ''))) LIKE '点击此处查看联系人信息%'
      OR LOWER(BTRIM(COALESCE(lead."companyName", ''))) LIKE 'click here to view%'
    THEN NULL ELSE lead."companyName" END,
  "contactName" = CASE
    WHEN LOWER(BTRIM(COALESCE(lead."contactName", ''))) IN
      ('在线', 'online', 'unavailable', '业务账户', 'business account')
      OR LOWER(BTRIM(COALESCE(lead."contactName", ''))) LIKE '最后上线于%'
      OR LOWER(BTRIM(COALESCE(lead."contactName", ''))) LIKE 'last seen%'
      OR LOWER(BTRIM(COALESCE(lead."contactName", ''))) LIKE '正在输入%'
      OR LOWER(BTRIM(COALESCE(lead."contactName", ''))) LIKE 'typing%'
      OR LOWER(BTRIM(COALESCE(lead."contactName", ''))) LIKE '点击此处查看联系人信息%'
      OR LOWER(BTRIM(COALESCE(lead."contactName", ''))) LIKE 'click here to view%'
    THEN NULL ELSE lead."contactName" END,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM "Conversation" AS conversation
  WHERE conversation."leadId" = lead."id"
    AND conversation."channel" = 'whatsapp'
)
AND (
  LOWER(BTRIM(COALESCE(lead."companyName", ''))) IN
    ('在线', 'online', 'unavailable', '业务账户', 'business account')
  OR LOWER(BTRIM(COALESCE(lead."companyName", ''))) LIKE '最后上线于%'
  OR LOWER(BTRIM(COALESCE(lead."companyName", ''))) LIKE 'last seen%'
  OR LOWER(BTRIM(COALESCE(lead."companyName", ''))) LIKE '正在输入%'
  OR LOWER(BTRIM(COALESCE(lead."companyName", ''))) LIKE 'typing%'
  OR LOWER(BTRIM(COALESCE(lead."companyName", ''))) LIKE '点击此处查看联系人信息%'
  OR LOWER(BTRIM(COALESCE(lead."companyName", ''))) LIKE 'click here to view%'
  OR LOWER(BTRIM(COALESCE(lead."contactName", ''))) IN
    ('在线', 'online', 'unavailable', '业务账户', 'business account')
  OR LOWER(BTRIM(COALESCE(lead."contactName", ''))) LIKE '最后上线于%'
  OR LOWER(BTRIM(COALESCE(lead."contactName", ''))) LIKE 'last seen%'
  OR LOWER(BTRIM(COALESCE(lead."contactName", ''))) LIKE '正在输入%'
  OR LOWER(BTRIM(COALESCE(lead."contactName", ''))) LIKE 'typing%'
  OR LOWER(BTRIM(COALESCE(lead."contactName", ''))) LIKE '点击此处查看联系人信息%'
  OR LOWER(BTRIM(COALESCE(lead."contactName", ''))) LIKE 'click here to view%'
);

UPDATE "Conversation"
SET "subject" = 'WhatsApp Conversation', "updatedAt" = CURRENT_TIMESTAMP
WHERE "channel" = 'whatsapp'
  AND (
    LOWER(BTRIM(COALESCE("subject", ''))) IN
      ('在线', 'online', 'unavailable', '业务账户', 'business account')
    OR LOWER(BTRIM(COALESCE("subject", ''))) LIKE '最后上线于%'
    OR LOWER(BTRIM(COALESCE("subject", ''))) LIKE 'last seen%'
    OR LOWER(BTRIM(COALESCE("subject", ''))) LIKE '正在输入%'
    OR LOWER(BTRIM(COALESCE("subject", ''))) LIKE 'typing%'
    OR LOWER(BTRIM(COALESCE("subject", ''))) LIKE '点击此处查看联系人信息%'
    OR LOWER(BTRIM(COALESCE("subject", ''))) LIKE 'click here to view%'
  );
