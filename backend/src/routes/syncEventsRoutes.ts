import { FastifyInstance } from 'fastify';
import { listSyncEvents, waitForSyncEventSignal } from '../services/imapEvents.js';
import { getUserId } from './syncHelpers.js';
import * as routeHelpers from './helpers.js';

const {
  parseNonNegativeIntWithCap,
  parsePositiveIntWithCap,
  MAX_SYNC_EVENT_ID,
  MAX_EVENTS_LIMIT,
  MAX_ACTIVE_EVENT_STREAMS_PER_USER,
  EVENT_STREAM_ERROR_BACKOFF_MS,
  tryAcquireEventStreamSlot,
  releaseEventStreamSlot,
} = routeHelpers;

export const registerSyncEventsRoutes = async (app: FastifyInstance) => {
  app.get('/api/events', async (req) => {
    const userId = getUserId(req);
    const queryObject = req.query as any;
    const since = parseNonNegativeIntWithCap(queryObject?.since, 0, MAX_SYNC_EVENT_ID);
    const limit = parsePositiveIntWithCap(queryObject?.limit, 100, MAX_EVENTS_LIMIT);
    return listSyncEvents(userId, since, limit);
  });

  app.get('/api/events/stream', async (req, reply) => {
    const userId = getUserId(req);
    if (!tryAcquireEventStreamSlot(userId)) {
      return reply.code(429).send({ error: `too many open event streams (max ${MAX_ACTIVE_EVENT_STREAMS_PER_USER})` });
    }
    const queryObject = req.query as any;
    let since = parseNonNegativeIntWithCap(queryObject?.since, 0, MAX_SYNC_EVENT_ID);
    let closed = false;
    const onClose = () => {
      closed = true;
    };
    try {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      req.raw.on('close', onClose);
      req.raw.on('aborted', onClose);

      reply.raw.write(`event: ready\ndata: {"since":${since}}\n\n`);

      while (!closed) {
        try {
          const events = await listSyncEvents(userId, since, 250);
          if (events.length > 0) {
            for (const event of events) {
              const eventId = Number((event as any).id ?? 0);
              if (Number.isFinite(eventId) && eventId > since) {
                since = eventId;
              }
              reply.raw.write(`id: ${eventId || since}\n`);
              reply.raw.write(`event: sync\n`);
              reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
            }
            continue;
          }

          const signal = await waitForSyncEventSignal(userId, since, 25_000);
          if (closed) {
            break;
          }
          if (!signal) {
            reply.raw.write(`event: ping\ndata: {"since":${since}}\n\n`);
          }
        } catch (error) {
          req.log.warn({ error }, 'sync event stream polling failed');
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: 'event stream failed' })}\n\n`);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, EVENT_STREAM_ERROR_BACKOFF_MS);
          });
        }
      }

      return reply;
    } finally {
      req.raw.off('close', onClose);
      req.raw.off('aborted', onClose);
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
      releaseEventStreamSlot(userId);
    }
  });
};
