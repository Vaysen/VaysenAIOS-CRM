import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

const apiBase = process.env.LAN04_API_BASE_URL || 'http://127.0.0.1:15442/api';
const origin = process.env.LAN04_ORIGIN || 'http://127.0.0.1:15445';
const companyId = process.env.LAN04_COMPANY_ID;
const leadId = process.env.LAN04_LEAD_ID;
const adminEmail = process.env.LAN04_ADMIN_EMAIL;
const adminPassword = process.env.LAN04_ADMIN_PASSWORD;
const viewerEmail = process.env.LAN04_VIEWER_EMAIL;
const viewerPassword = process.env.LAN04_VIEWER_PASSWORD;

for (const [name, value] of Object.entries({ companyId, leadId, adminEmail, adminPassword, viewerEmail, viewerPassword })) {
  if (!value) throw new Error(`Missing ${name}`);
}

const prisma = new PrismaClient();
const headers = (token) => ({ ...(token ? { authorization: `Bearer ${token}` } : {}), origin, 'content-type': 'application/json', 'x-company-id': companyId });

async function call(token, path, method = 'GET', body) {
  const response = await fetch(`${apiBase}${path}`, { method, headers: headers(token), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

async function login(email, password) {
  const result = await call('', '/auth/login', 'POST', { email, password });
  assert.equal(result.status, 200, `login failed: ${JSON.stringify(result.body)}`);
  return result.body.accessToken;
}

async function plan(token, toolName, parameters, requestId) {
  const result = await call(token, '/assistant-tools/plan', 'POST', { companyId, toolName, parameters, requestId });
  assert.equal(result.status, 201, `plan failed: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function confirm(token, id) {
  const result = await call(token, `/assistant-tools/${id}/confirm`, 'POST', {});
  assert.equal(result.status, 201, `confirm failed: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function counts() {
  const [conversations, messages, reminders, outbox, emailDispatch] = await Promise.all([
    prisma.conversation.count({ where: { companyId } }),
    prisma.communicationMessage.count({ where: { conversation: { companyId } } }),
    prisma.followUpReminder.count({ where: { companyId, reason: { startsWith: 'assistant_execution:' } } }),
    prisma.externalActionOutbox.count({ where: { companyId } }),
    prisma.emailDispatchRequest.count({ where: { companyId } }),
  ]);
  return { conversations, messages, reminders, outbox, emailDispatch };
}

const admin = await login(adminEmail, adminPassword);
const viewer = await login(viewerEmail, viewerPassword);

const viewerBefore = await counts();
const viewerPlan = await plan(viewer, 'message_draft_prepare', { leadId, channel: 'email', body: 'viewer must not persist this draft' }, `real-viewer-${Date.now()}`);
const viewerConfirm = await confirm(viewer, viewerPlan.id);
assert.equal(viewerConfirm.state, 'FAILED');
assert.equal(viewerConfirm.errorCode, 'TOOL_REJECTED_403');
assert.deepEqual(await counts(), viewerBefore);

const draftPlan = await plan(admin, 'message_draft_prepare', { leadId, channel: 'email', subject: 'real draft', body: 'real authenticated draft' }, `real-draft-${Date.now()}`);
assert.equal(draftPlan.state, 'AWAITING_CONFIRMATION');
const draft = await confirm(admin, draftPlan.id);
assert.equal(draft.state, 'SUCCEEDED');
assert.equal(draft.result.sent, false);
const afterDraft = await counts();
assert.equal(afterDraft.messages, viewerBefore.messages + 1);
assert.equal(afterDraft.outbox, 0);
assert.equal(afterDraft.emailDispatch, 0);

const noSideEffectPlan = await plan(admin, 'task_follow_up_create', { leadId, title: 'expired recovery task', dueAt: '2030-01-01T00:00:00.000Z', priority: 'Medium' }, `real-recover-empty-${Date.now()}`);
await prisma.assistantToolExecution.update({ where: { id: noSideEffectPlan.id }, data: { state: 'RUNNING', startedAt: new Date(Date.now() - 120_000) } });
const remindersBeforeRecovery = (await counts()).reminders;
const recoveredEmpty = await confirm(admin, noSideEffectPlan.id);
assert.equal(recoveredEmpty.state, 'SUCCEEDED');
assert.equal((await counts()).reminders, remindersBeforeRecovery + 1);

const sideEffectPlan = await plan(admin, 'message_draft_prepare', { leadId, channel: 'whatsapp', body: 'side effect then final update recovery' }, `real-recover-existing-${Date.now()}`);
const firstSideEffect = await confirm(admin, sideEffectPlan.id);
assert.equal(firstSideEffect.state, 'SUCCEEDED');
const messagesBeforeReconcile = (await counts()).messages;
await prisma.assistantToolExecution.update({ where: { id: sideEffectPlan.id }, data: { state: 'RUNNING', startedAt: new Date(Date.now() - 120_000) } });
const reconciled = await confirm(admin, sideEffectPlan.id);
assert.equal(reconciled.state, 'SUCCEEDED');
assert.equal((await counts()).messages, messagesBeforeReconcile);

const healthyPlan = await plan(admin, 'message_draft_prepare', { leadId, channel: 'email', body: 'healthy running must not dispatch' }, `real-healthy-${Date.now()}`);
await prisma.assistantToolExecution.update({ where: { id: healthyPlan.id }, data: { state: 'RUNNING', startedAt: new Date() } });
const healthyBefore = await counts();
const healthy = await confirm(admin, healthyPlan.id);
assert.equal(healthy.state, 'RUNNING');
assert.deepEqual(await counts(), healthyBefore);

const concurrentPlan = await plan(admin, 'task_follow_up_create', { leadId, title: 'concurrent recovery task', dueAt: '2030-01-02T00:00:00.000Z', priority: 'High' }, `real-recover-concurrent-${Date.now()}`);
await prisma.assistantToolExecution.update({ where: { id: concurrentPlan.id }, data: { state: 'RUNNING', startedAt: new Date(Date.now() - 120_000) } });
const concurrentBefore = (await counts()).reminders;
const concurrent = await Promise.all([confirm(admin, concurrentPlan.id), confirm(admin, concurrentPlan.id)]);
assert.ok(concurrent.every((item) => ['RUNNING', 'SUCCEEDED'].includes(item.state)));
assert.equal((await counts()).reminders, concurrentBefore + 1);

const history = await call(admin, `/assistant-tools/history?companyId=${companyId}`);
assert.equal(history.status, 200);
assert.ok(history.body.some((item) => item.id === sideEffectPlan.id && item.state === 'SUCCEEDED'));
console.log(JSON.stringify({ viewer: viewerConfirm.state, viewerCountsUnchanged: true, draft: draft.state, recoveredEmpty: recoveredEmpty.state, reconciled: reconciled.state, healthy: healthy.state, concurrent: concurrent.map((item) => item.state), finalCounts: await counts() }, null, 2));
await prisma.$disconnect();
