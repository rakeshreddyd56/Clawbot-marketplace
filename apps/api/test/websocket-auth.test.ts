/**
 * BUG-CRIT-001: WebSocket endpoint authentication tests
 *
 * Verifies that:
 * - Unauthenticated WebSocket connections are rejected
 * - Authenticated connections are accepted
 * - Non-admin users cannot see other agents' events
 * - Both /v1/events/ws and /v1/realtime are protected
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { createApp, type AppServices } from '../src/app.js';
import { issueSessionToken } from '../src/core/session.js';
import { authHeaders, onboardAgent, topup } from './helpers.js';

function waitForMessage(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for close')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

function waitForOpen(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('Timeout waiting for open')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('BUG-CRIT-001: WebSocket authentication', () => {
  let app: FastifyInstance;
  let services: AppServices;
  let baseUrl: string;

  beforeEach(async () => {
    const built = await createApp();
    app = built.app;
    services = built.services;
    // Listen on random port for real WebSocket connections
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address.replace('http', 'ws');
  });

  afterEach(async () => {
    await app.close();
  });

  // --- /v1/events/ws tests ---

  it('rejects unauthenticated connection to /v1/events/ws', async () => {
    const ws = new WebSocket(`${baseUrl}/v1/events/ws`);

    // Should receive an error message and then close
    const msgPromise = waitForMessage(ws);
    const closePromise = waitForClose(ws);

    const msg = await msgPromise;
    const parsed = JSON.parse(msg);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe('AUTH_REQUIRED');

    const close = await closePromise;
    expect(close.code).toBe(1008);
  });

  it('accepts authenticated connection to /v1/events/ws with Bearer token', async () => {
    // Onboard an agent first to get a valid agent
    const agent = await onboardAgent(app, {
      tokenSeed: 'ws_auth_worker',
      role: 'worker',
      capabilities: ['python']
    });

    const token = issueSessionToken({
      sub: agent.agentId,
      role: 'worker'
    });

    const ws = new WebSocket(`${baseUrl}/v1/events/ws`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    await waitForOpen(ws);

    // Connection should stay open — publish an event and verify we receive it
    services.audit.publish('test.event', agent.agentId, { msg: 'hello' });

    const msg = await waitForMessage(ws);
    const parsed = JSON.parse(msg);
    expect(parsed.eventType).toBe('test.event');
    expect(parsed.entityId).toBe(agent.agentId);

    ws.close();
  });

  it('accepts authenticated connection to /v1/events/ws with header auth', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'ws_auth_header_worker',
      role: 'worker',
      capabilities: ['python']
    });

    const ws = new WebSocket(`${baseUrl}/v1/events/ws`, {
      headers: authHeaders(agent.agentId, 'worker')
    });

    await waitForOpen(ws);

    // Publish an event for this agent — should receive it
    services.audit.publish('test.event', agent.agentId, { msg: 'header-auth' });

    const msg = await waitForMessage(ws);
    const parsed = JSON.parse(msg);
    expect(parsed.eventType).toBe('test.event');

    ws.close();
  });

  it('non-privileged user does not receive events for other agents on /v1/events/ws', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'ws_filter_worker',
      role: 'worker',
      capabilities: ['python']
    });

    const token = issueSessionToken({
      sub: worker.agentId,
      role: 'worker'
    });

    const ws = new WebSocket(`${baseUrl}/v1/events/ws`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    await waitForOpen(ws);

    // Publish an event for a different entity — should NOT be received
    services.audit.publish('test.other', 'some-other-agent-id', { msg: 'not-mine' });

    // Publish an event for this agent — should be received
    services.audit.publish('test.mine', worker.agentId, { msg: 'mine' });

    const msg = await waitForMessage(ws);
    const parsed = JSON.parse(msg);
    expect(parsed.eventType).toBe('test.mine');
    expect(parsed.entityId).toBe(worker.agentId);

    ws.close();
  });

  it('admin receives all events on /v1/events/ws without filtering', async () => {
    const admin = await onboardAgent(app, {
      tokenSeed: 'ws_admin_all',
      role: 'admin',
      capabilities: ['moderation']
    });

    const token = issueSessionToken({
      sub: admin.agentId,
      role: 'admin'
    });

    const ws = new WebSocket(`${baseUrl}/v1/events/ws`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    await waitForOpen(ws);

    // Publish an event for a different entity — admin should receive it
    services.audit.publish('test.global', 'unrelated-entity-123', { msg: 'global' });

    const msg = await waitForMessage(ws);
    const parsed = JSON.parse(msg);
    expect(parsed.eventType).toBe('test.global');
    expect(parsed.entityId).toBe('unrelated-entity-123');

    ws.close();
  });

  // --- /v1/realtime tests ---

  it('rejects unauthenticated connection to /v1/realtime', async () => {
    const ws = new WebSocket(`${baseUrl}/v1/realtime`);

    const msgPromise = waitForMessage(ws);
    const closePromise = waitForClose(ws);

    const msg = await msgPromise;
    const parsed = JSON.parse(msg);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe('AUTH_REQUIRED');

    const close = await closePromise;
    expect(close.code).toBe(1008);
  });

  it('accepts authenticated connection to /v1/realtime with Bearer token', async () => {
    const agent = await onboardAgent(app, {
      tokenSeed: 'ws_realtime_worker',
      role: 'worker',
      capabilities: ['python']
    });

    const token = issueSessionToken({
      sub: agent.agentId,
      role: 'worker'
    });

    const ws = new WebSocket(`${baseUrl}/v1/realtime?channels=task.*`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    await waitForOpen(ws);

    // Publish a task event for this agent
    services.audit.publish('task.created', agent.agentId, { msg: 'realtime' });

    const msg = await waitForMessage(ws);
    const parsed = JSON.parse(msg);
    expect(parsed.channel).toBe('task.*');
    expect(parsed.event.eventType).toBe('task.created');

    ws.close();
  });

  it('non-privileged user does not receive events for other agents on /v1/realtime', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'ws_realtime_filter',
      role: 'worker',
      capabilities: ['python']
    });

    const token = issueSessionToken({
      sub: worker.agentId,
      role: 'worker'
    });

    const ws = new WebSocket(`${baseUrl}/v1/realtime?channels=task.*`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    await waitForOpen(ws);

    // Publish an event for another entity — should NOT be received
    services.audit.publish('task.created', 'other-agent-999', { msg: 'not-mine' });

    // Publish an event for this agent — should be received
    services.audit.publish('task.posted', worker.agentId, { msg: 'mine' });

    const msg = await waitForMessage(ws);
    const parsed = JSON.parse(msg);
    expect(parsed.event.eventType).toBe('task.posted');
    expect(parsed.event.entityId).toBe(worker.agentId);

    ws.close();
  });

  it('moderator receives all events on /v1/realtime without filtering', async () => {
    const moderator = await onboardAgent(app, {
      tokenSeed: 'ws_realtime_mod',
      role: 'moderator',
      capabilities: ['moderation']
    });

    const token = issueSessionToken({
      sub: moderator.agentId,
      role: 'moderator'
    });

    const ws = new WebSocket(`${baseUrl}/v1/realtime?channels=dispute.*`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    await waitForOpen(ws);

    // Publish a dispute event for a different entity — moderator should receive it
    services.audit.publish('dispute.opened', 'dispute-xyz', { msg: 'for-mod' });

    const msg = await waitForMessage(ws);
    const parsed = JSON.parse(msg);
    expect(parsed.channel).toBe('dispute.*');
    expect(parsed.event.entityId).toBe('dispute-xyz');

    ws.close();
  });

  it('accepts entityId filter on /v1/events/ws for authenticated users', async () => {
    const worker = await onboardAgent(app, {
      tokenSeed: 'ws_entity_filter',
      role: 'worker',
      capabilities: ['python']
    });

    const token = issueSessionToken({
      sub: worker.agentId,
      role: 'worker'
    });

    const entityId = 'task-abc-123';
    const ws = new WebSocket(`${baseUrl}/v1/events/ws?entityId=${entityId}`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    await waitForOpen(ws);

    // Publish event for different entity — should not receive
    services.audit.publish('task.created', 'task-other', { msg: 'wrong-entity' });

    // Publish event for filtered entity — should receive
    services.audit.publish('task.posted', entityId, { msg: 'right-entity' });

    const msg = await waitForMessage(ws);
    const parsed = JSON.parse(msg);
    expect(parsed.entityId).toBe(entityId);
    expect(parsed.eventType).toBe('task.posted');

    ws.close();
  });
});
