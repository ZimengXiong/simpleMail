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
     DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent, updated_at = NOW()
     RETURNING id`,
    [subscription.userId, subscription.endpoint, subscription.p256dh, subscription.auth, subscription.userAgent ?? null],
  );
  return result.rows[0];
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
    ).catch(() => {
      // ignore delivery failures
    });
  }
};
