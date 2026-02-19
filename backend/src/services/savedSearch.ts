import { query } from '../db/pool.js';
import { parseMessageSearchQuery } from './search.js';

const resolveQueryAst = (queryText: string, queryAst?: Record<string, any>) => {
  if (queryAst) {
    return queryAst;
  }
  try {
    return parseMessageSearchQuery(queryText);
  } catch {
    return {};
  }
};

export interface SavedSearchRecord {
  id: string;
  name: string;
  queryText: string;
  queryAst: Record<string, any>;
  isStarred: boolean;
  createdAt: string;
  updatedAt: string;
}

export const listSavedSearches = async (userId: string): Promise<SavedSearchRecord[]> => {
  const result = await query<SavedSearchRecord>(`
    SELECT id, name, query_text as "queryText", query_ast as "queryAst", is_starred as "isStarred", created_at as "createdAt", updated_at as "updatedAt"
      FROM saved_searches
     WHERE user_id = $1
     ORDER BY is_starred DESC, updated_at DESC, created_at DESC
  `, [userId]);
  return result.rows;
};

export const getSavedSearch = async (userId: string, id: string): Promise<SavedSearchRecord | null> => {
  const result = await query<SavedSearchRecord>(`
    SELECT id, name, query_text as "queryText", query_ast as "queryAst", is_starred as "isStarred", created_at as "createdAt", updated_at as "updatedAt"
      FROM saved_searches
     WHERE id = $1
       AND user_id = $2
  `, [id, userId]);
  return result.rows[0] ?? null;
};

export const createSavedSearch = async (
  userId: string,
  payload: {
    name: string;
    queryText: string;
    queryAst?: Record<string, any>;
    isStarred?: boolean;
  },
) => {
  const savedAst = resolveQueryAst(payload.queryText, payload.queryAst);
  const result = await query<{ id: string }>(`
    INSERT INTO saved_searches (user_id, name, query_text, query_ast, is_starred)
    VALUES ($1, $2, $3, $4::jsonb, $5)
    ON CONFLICT (user_id, name) DO UPDATE
      SET query_text = EXCLUDED.query_text,
          query_ast = EXCLUDED.query_ast,
          is_starred = EXCLUDED.is_starred,
          updated_at = NOW()
    RETURNING id
  `, [userId, payload.name, payload.queryText, JSON.stringify(savedAst), payload.isStarred ?? false]);
  return { id: result.rows[0].id };
};

export const updateSavedSearch = async (
  userId: string,
  id: string,
  payload: {
    name?: string;
    queryText?: string;
    queryAst?: Record<string, any>;
    isStarred?: boolean;
  },
) => {
  const sets: string[] = ['updated_at = NOW()'];
  const values: any[] = [id, userId];

  if (payload.name !== undefined) {
    values.push(payload.name);
    sets.push(`name = $${values.length}`);
  }
  if (payload.queryText !== undefined) {
    values.push(payload.queryText);
    sets.push(`query_text = $${values.length}`);
  }

  if (payload.queryText !== undefined || payload.queryAst !== undefined) {
    const resolvedAst = resolveQueryAst(payload.queryText ?? '', payload.queryAst);
    values.push(JSON.stringify(resolvedAst));
    sets.push(`query_ast = $${values.length}::jsonb`);
  }
  if (payload.isStarred !== undefined) {
    values.push(payload.isStarred);
    sets.push(`is_starred = $${values.length}`);
  }

  if (sets.length === 1) {
    return;
  }

  await query(
    `UPDATE saved_searches SET ${sets.join(', ')}
      WHERE id = $1
        AND user_id = $2`,
    values,
  );
};

export const deleteSavedSearch = async (userId: string, id: string) => {
  await query('DELETE FROM saved_searches WHERE id = $1 AND user_id = $2', [id, userId]);
};
