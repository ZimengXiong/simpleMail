import { FastifyInstance } from 'fastify';
import {
  QuickFiltersResponse,
  SearchSuggestionsResponse,
  getUserId,
  getSavedSearch,
  createSavedSearch,
  listSavedSearches,
  query,
  updateSavedSearch,
  deleteSavedSearch,
  getIncomingConnectorGmailLikeCached,
  normalizeConnectorFolderFilterWithConnector,
  buildGmailFolderPredicatesWithConnector,
  logicalMessageKeySql,
  mailboxReadPreferenceRankSql,
  parseMessageSearchQuery,
  buildMessageSearchQuery,
  parsePositiveIntWithCap,
  parseNonNegativeIntWithCap,
  getQuickFiltersCache,
  setQuickFiltersCache,
  getSearchSuggestionsCache,
  setSearchSuggestionsCache,
  MAX_MESSAGES_PAGE_LIMIT,
  MAX_MESSAGES_OFFSET,
  MAX_MESSAGES_SEARCH_QUERY_CHARS,
  SEARCH_QUICK_FILTERS_CACHE_TTL_MS,
  SEARCH_QUICK_FILTERS_CACHE_MAX,
  SEARCH_SUGGESTIONS_CACHE_TTL_MS,
  SEARCH_SUGGESTIONS_CACHE_MAX,
  MAX_SEARCH_SUGGESTION_QUERY_CHARS,
  MAX_SAVED_SEARCH_NAME_CHARS,
  MAX_SAVED_SEARCH_QUERY_CHARS,
} from './messages-context.js';

export const registerMessageSearchRoutes = async (app: FastifyInstance) => {
  app.post('/api/messages/search', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    let q = body?.q ?? body?.query;
    if (!q && body?.savedSearchId) {
      const saved = await getSavedSearch(userId, String(body.savedSearchId));
      if (!saved) {
        return reply.code(404).send({ error: 'saved search not found' });
      }
      q = saved.queryText;
    }
    const normalizedQuery = String(q ?? '').trim();
    if (!normalizedQuery) {
      return reply.code(400).send({ error: 'q is required' });
    }
    if (normalizedQuery.length > MAX_MESSAGES_SEARCH_QUERY_CHARS) {
      return reply.code(400).send({ error: `q exceeds ${MAX_MESSAGES_SEARCH_QUERY_CHARS} characters` });
    }
    const limit = parsePositiveIntWithCap(body?.limit, 50, MAX_MESSAGES_PAGE_LIMIT);
    const connectorId = String(body?.connectorId ?? '').trim();
    const resolvedConnectorIsGmailLike = connectorId
      ? await getIncomingConnectorGmailLikeCached(userId, connectorId)
      : null;
    const resolvedConnector = connectorId && resolvedConnectorIsGmailLike !== null
      ? (resolvedConnectorIsGmailLike ? { provider: 'gmail' } : { provider: 'imap' })
      : null;
    const folder = normalizeConnectorFolderFilterWithConnector(
      body?.folder as string | undefined,
      resolvedConnector,
    );
    const normalizedFolder = String(folder ?? '').trim().toUpperCase();

    const parsed = parseMessageSearchQuery(normalizedQuery);
    const parsedResult = buildMessageSearchQuery(userId, parsed);
    const values = parsedResult.values;
    const predicates = parsedResult.predicates;
    const folderFilter = buildGmailFolderPredicatesWithConnector(
      body?.folder as string | undefined,
      resolvedConnector,
    );
    if (normalizedFolder !== 'STARRED' && folder) {
      if (folderFilter.candidates && folderFilter.candidates.length > 0) {
        if (folderFilter.candidates.length === 1) {
          values.push(folderFilter.candidates[0]);
          predicates.push(`m.folder_path_norm = $${values.length}`);
        } else {
          values.push(folderFilter.candidates);
          predicates.push(`m.folder_path_norm = ANY($${values.length}::text[])`);
        }
      } else {
        values.push(String(folder).toUpperCase());
        predicates.push(`m.folder_path_norm = $${values.length}`);
      }
    }
    if (connectorId) {
      values.push(connectorId);
      predicates.push(`m.incoming_connector_id = $${values.length}`);
    }
    if (normalizedFolder === 'STARRED') {
      predicates.push('m.is_starred = TRUE');
    }

    const shouldDedupeLogicalMessages = !folder || folderFilter.dedupeLogicalMessages;
    const dedupeKeyExpr = logicalMessageKeySql('m');

    const offset = parseNonNegativeIntWithCap((req.body as any)?.offset, 0, MAX_MESSAGES_OFFSET);
    const countValues = [...values];
    const rowsValues = [...values, limit, offset];

    const [countResult, result] = await Promise.all([
      shouldDedupeLogicalMessages
        ? query<{ count: string }>(
            `SELECT COUNT(*)::int as count
               FROM (
                 SELECT DISTINCT m.incoming_connector_id, ${dedupeKeyExpr}
                   FROM messages m
                   INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
                  WHERE ${predicates.join(' AND ')}
               ) dedup`,
            countValues,
          )
        : query<{ count: string }>(
            `SELECT COUNT(*)::int as count
               FROM messages m
               INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
              WHERE ${predicates.join(' AND ')}`,
            countValues,
          ),
      shouldDedupeLogicalMessages
        ? query<any>(
            `WITH dedup AS (
             SELECT DISTINCT ON (m.incoming_connector_id, ${dedupeKeyExpr})
                    m.id,
                    m.incoming_connector_id as "incomingConnectorId",
                    m.message_id as "messageId",
                    m.subject,
                    m.from_header as "fromHeader",
                    m.to_header as "toHeader",
                    m.folder_path as "folderPath",
                    m.snippet,
                    m.received_at as "receivedAt",
                    m.thread_id as "threadId",
                    m.is_read as "isRead",
                    m.is_starred as "isStarred"
               FROM messages m
               INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
              WHERE ${predicates.join(' AND ')}
              ORDER BY
                m.incoming_connector_id,
                ${dedupeKeyExpr},
                ${mailboxReadPreferenceRankSql},
                m.received_at DESC NULLS LAST,
                m.updated_at DESC,
                m.id DESC
           ),
           paged AS (
             SELECT *
               FROM dedup
              ORDER BY "receivedAt" DESC, id DESC
              LIMIT $${rowsValues.length - 1} OFFSET $${rowsValues.length}
           ),
           thread_ids AS (
             SELECT DISTINCT
                    p."incomingConnectorId" as incoming_connector_id,
                    p."threadId" as thread_id
               FROM paged p
              WHERE p."threadId" IS NOT NULL
           ),
           thread_stats AS (
             SELECT m3.incoming_connector_id,
                    m3.thread_id,
                    COUNT(DISTINCT ${logicalMessageKeySql('m3')})::int as thread_count,
                    COALESCE(
                      jsonb_agg(DISTINCT m3.from_header) FILTER (WHERE m3.from_header IS NOT NULL),
                      '[]'::jsonb
                    ) as participants
               FROM messages m3
               INNER JOIN thread_ids ti
                 ON ti.incoming_connector_id = m3.incoming_connector_id
                AND ti.thread_id = m3.thread_id
              GROUP BY m3.incoming_connector_id, m3.thread_id
           )
           SELECT p.id,
                  p."incomingConnectorId",
                  p."messageId",
                  p.subject,
                  p."fromHeader",
                  p."toHeader",
                  p."folderPath",
                  p.snippet,
                  p."receivedAt",
                  p."threadId",
                  p."isRead",
                  p."isStarred",
                  CASE
                    WHEN p."threadId" IS NULL THEN 1
                    ELSE COALESCE(ts.thread_count, 1)
                  END as "threadCount",
                  CASE
                    WHEN p."threadId" IS NULL THEN
                      CASE
                        WHEN p."fromHeader" IS NULL THEN '[]'::jsonb
                        ELSE jsonb_build_array(p."fromHeader")
                      END
                    ELSE COALESCE(ts.participants, '[]'::jsonb)
                  END as participants
             FROM paged p
             LEFT JOIN thread_stats ts
               ON ts.incoming_connector_id = p."incomingConnectorId"
              AND ts.thread_id = p."threadId"
            ORDER BY p."receivedAt" DESC, p.id DESC`,
            rowsValues,
          )
        : query<any>(
            `SELECT m.id,
                  m.incoming_connector_id as "incomingConnectorId",
                  m.message_id as "messageId",
                  m.subject,
                  m.from_header as "fromHeader",
                  m.to_header as "toHeader",
                  m.folder_path as "folderPath",
                  m.snippet,
                  m.received_at as "receivedAt",
                  m.thread_id as "threadId",
                  m.is_read as "isRead",
                  m.is_starred as "isStarred",
                  1 as "threadCount",
                  jsonb_build_array(m.from_header) as participants
             FROM messages m
             INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
            WHERE ${predicates.join(' AND ')}
            ORDER BY m.received_at DESC
            LIMIT $${rowsValues.length - 1} OFFSET $${rowsValues.length}`,
            rowsValues,
          ),
    ]);
    return {
      messages: result.rows,
      totalCount: Number(countResult.rows[0]?.count ?? 0),
    };
  });

  app.get('/api/search/quick-filters', async (req) => {
    const userId = getUserId(req);
    const cached = getQuickFiltersCache(userId);
    if (cached) {
      return cached.value;
    }

    const [labelRows, starredRow, attachmentRow, fromResult] = await Promise.all([
      query<{ key: string; name: string; count: number }>(
        `SELECT l.key, l.name, COUNT(ml.message_id)::int as count
           FROM labels l
           LEFT JOIN message_labels ml ON ml.label_id = l.id
           LEFT JOIN messages m ON m.id = ml.message_id
           LEFT JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
           WHERE l.user_id = $1
             AND l.is_archived = FALSE
             AND (ic.user_id = $1 OR m.id IS NULL)
           GROUP BY l.key, l.name
           ORDER BY COUNT(ml.message_id) DESC, l.name ASC`,
        [userId],
      ),
      query<{ count: number }>(
        `SELECT COUNT(*)::int as count
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE ic.user_id = $1 AND m.is_starred = TRUE`,
        [userId],
      ),
      query<{ count: number }>(
        `SELECT COUNT(DISTINCT m.id)::int as count
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
           INNER JOIN attachments a ON a.message_id = m.id
          WHERE ic.user_id = $1`,
        [userId],
      ),
      query<{ fromHeader: string; count: number }>(
        `SELECT m.from_header as "fromHeader", COUNT(*)::int as count
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE ic.user_id = $1
            AND m.from_header IS NOT NULL
            AND m.from_header <> ''
          GROUP BY m.from_header
          ORDER BY COUNT(*) DESC, m.from_header
          LIMIT 10`,
        [userId],
      ),
    ]);

    const payload: QuickFiltersResponse = {
      labels: labelRows.rows,
      starred: Number(starredRow.rows[0]?.count ?? 0),
      withAttachments: Number(attachmentRow.rows[0]?.count ?? 0),
      topFrom: fromResult.rows,
    };
    setQuickFiltersCache(userId, payload, SEARCH_QUICK_FILTERS_CACHE_TTL_MS, SEARCH_QUICK_FILTERS_CACHE_MAX);
    return payload;
  });

  app.get('/api/search/suggestions', async (req, reply) => {
    const userId = getUserId(req);
    const queryText = String((req.query as any)?.q ?? '').trim();
    if (!queryText) {
      return reply.code(400).send({ error: 'q is required' });
    }
    if (queryText.length > MAX_SEARCH_SUGGESTION_QUERY_CHARS) {
      return reply.code(400).send({ error: `q exceeds ${MAX_SEARCH_SUGGESTION_QUERY_CHARS} characters` });
    }
    const cacheKey = `${userId}:${queryText.toLowerCase()}`;
    const cached = getSearchSuggestionsCache(cacheKey);
    if (cached) {
      return cached.value;
    }

    const prefix = `%${queryText}%`;
    const [labelResult, fromResult, subjectResult] = await Promise.all([
      query<{ key: string; name: string }>(
        `SELECT key, name
           FROM labels
          WHERE user_id = $1
            AND is_archived = FALSE
            AND (key ILIKE $2 OR name ILIKE $2)
          LIMIT 10`,
        [userId, prefix],
      ),
      query<{ fromHeader: string; count: number }>(
        `SELECT from_header as "fromHeader", COUNT(*)::int as count
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE ic.user_id = $1
            AND from_header ILIKE $2
          GROUP BY from_header
          ORDER BY COUNT(*) DESC, from_header
          LIMIT 10`,
        [userId, prefix],
      ),
      query<{ subject: string; count: number }>(
        `SELECT subject, COUNT(*)::int as count
           FROM messages m
           INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
          WHERE ic.user_id = $1
            AND subject ILIKE $2
          GROUP BY subject
          ORDER BY COUNT(*) DESC, subject
          LIMIT 10`,
        [userId, prefix],
      ),
    ]);

    const payload: SearchSuggestionsResponse = {
      labels: labelResult.rows,
      from: fromResult.rows,
      subjects: subjectResult.rows,
    };
    setSearchSuggestionsCache(
      cacheKey,
      payload,
      SEARCH_SUGGESTIONS_CACHE_TTL_MS,
      SEARCH_SUGGESTIONS_CACHE_MAX,
    );
    return payload;
  });

  app.get('/api/saved-searches', async (req) => {
    const userId = getUserId(req);
    return listSavedSearches(userId);
  });

  app.post('/api/saved-searches', async (req, reply) => {
    const userId = getUserId(req);
    const body = req.body as any;
    if (!body?.name || !body?.queryText) {
      return reply.code(400).send({ error: 'name and queryText required' });
    }
    const name = String(body.name).trim();
    const queryText = String(body.queryText).trim();
    if (!name || !queryText) {
      return reply.code(400).send({ error: 'name and queryText required' });
    }
    if (name.length > MAX_SAVED_SEARCH_NAME_CHARS) {
      return reply.code(400).send({ error: `name exceeds ${MAX_SAVED_SEARCH_NAME_CHARS} characters` });
    }
    if (queryText.length > MAX_SAVED_SEARCH_QUERY_CHARS) {
      return reply.code(400).send({ error: `queryText exceeds ${MAX_SAVED_SEARCH_QUERY_CHARS} characters` });
    }
    return createSavedSearch(userId, {
      name,
      queryText,
      isStarred: body.isStarred === true,
      queryAst: body.queryAst,
    });
  });

  app.get('/api/saved-searches/:id', async (req, reply) => {
    const userId = getUserId(req);
    const id = String((req.params as any).id);
    const saved = await getSavedSearch(userId, id);
    if (!saved) {
      return reply.code(404).send({ error: 'saved search not found' });
    }
    return saved;
  });

  app.patch('/api/saved-searches/:id', async (req, reply) => {
    const userId = getUserId(req);
    const id = String((req.params as any).id);
    const body = req.body as any;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'request body required' });
    }
    const nextName = body.name === undefined ? undefined : String(body.name).trim();
    const nextQueryText = body.queryText === undefined ? undefined : String(body.queryText).trim();
    if (nextName !== undefined && !nextName) {
      return reply.code(400).send({ error: 'name cannot be empty' });
    }
    if (nextQueryText !== undefined && !nextQueryText) {
      return reply.code(400).send({ error: 'queryText cannot be empty' });
    }
    if (nextName && nextName.length > MAX_SAVED_SEARCH_NAME_CHARS) {
      return reply.code(400).send({ error: `name exceeds ${MAX_SAVED_SEARCH_NAME_CHARS} characters` });
    }
    if (nextQueryText && nextQueryText.length > MAX_SAVED_SEARCH_QUERY_CHARS) {
      return reply.code(400).send({ error: `queryText exceeds ${MAX_SAVED_SEARCH_QUERY_CHARS} characters` });
    }
    await updateSavedSearch(userId, id, {
      name: nextName,
      queryText: nextQueryText,
      queryAst: body.queryAst,
      isStarred: body.isStarred,
    });
    const updated = await getSavedSearch(userId, id);
    if (!updated) {
      return reply.code(404).send({ error: 'saved search not found' });
    }
    return updated;
  });

  app.delete('/api/saved-searches/:id', async (req, reply) => {
    const userId = getUserId(req);
    const id = String((req.params as any).id);
    await deleteSavedSearch(userId, id);
    return { status: 'deleted', id };
  });
};
