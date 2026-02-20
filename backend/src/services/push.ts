import webPush from 'web-push';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';

export const configurePush = () => {
  if (!env.push.enabled) {
    return;
  }

  webPush.setVapidDetails(env.push.email, env.push.publicKey, env.push.privateKey);
};

configurePush();

const conflictError = (message: string) => {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 409;
  return error;
};

export const createPushSubscription = async (subscription: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}) => {
  const result = await query<{ id: string }>(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint)
     DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent, updated_at = NOW()
     WHERE push_subscriptions.user_id = EXCLUDED.user_id
     RETURNING id`,
    [subscription.userId, subscription.endpoint, subscription.p256dh, subscription.auth, subscription.userAgent ?? null],
  );

  const created = result.rows[0];
  if (created) {
    return created;
  }

  const existing = await query<{ user_id: string }>(
    'SELECT user_id FROM push_subscriptions WHERE endpoint = $1',
    [subscription.endpoint],
  );
  if (existing.rows[0]?.user_id && existing.rows[0].user_id !== subscription.userId) {
    throw conflictError('push endpoint is already registered to another user');
  }

  throw new Error('failed to create push subscription');
};

export const removePushSubscription = async (userId: string, endpoint: string) => {
  await query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
};

export const notifySubscribers = async (userId: string, payload: Record<string, any>) => {
  if (!env.push.enabled) {
    return;
  }

  const subs = await query<{ endpoint: string; p256dh: string; auth: string }>(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId],
  );
  const result = subs.rows;

  const subscriptionPayload = JSON.stringify(payload);
  for (const sub of result) {
    await webPush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
      } as any,
      subscriptionPayload,
    ).catch(() => {});
  }
};
