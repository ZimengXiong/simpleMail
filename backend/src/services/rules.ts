import { query } from '../db/pool.js';
import { moveMessageInMailbox, setMessageReadState, setMessageStarredState } from './imap.js';

export interface RuleMatch {
  fromContains?: string;
  toContains?: string;
  subjectContains?: string;
  hasAttachment?: boolean;
  listIdContains?: string;
}

export interface RuleAction {
  markRead?: boolean;
  star?: boolean;
  markUnread?: boolean;
  moveToFolder?: string;
  notify?: {
    title?: string;
    body?: string;
  };
}

export interface Rule {
  id: string;
  name: string;
  matchingScope: string;
  matchConditions: RuleMatch;
  actions: RuleAction;
}

const normalize = (value?: string | null) => String(value ?? '').toLowerCase();

const matchRule = async (rule: Rule, message: {
  fromHeader: string | null;
  toHeader: string | null;
  subject: string | null;
  messageId: string | null;
  rawHeaders?: Record<string, any> | null;
  incomingConnectorId?: string;
  folderPath?: string;
  uid?: number | null;
}, attachmentCount: number) => {
  const conditions = rule.matchConditions || {};

  if (conditions.fromContains && !normalize(message.fromHeader).includes(normalize(conditions.fromContains))) {
    return false;
  }

  if (conditions.toContains && !normalize(message.toHeader).includes(normalize(conditions.toContains))) {
    return false;
  }

  if (conditions.subjectContains && !normalize(message.subject).includes(normalize(conditions.subjectContains))) {
    return false;
  }

  if (typeof conditions.hasAttachment === 'boolean' && (attachmentCount > 0) !== conditions.hasAttachment) {
    return false;
  }

  if (conditions.listIdContains) {
    const listId = normalize((message.rawHeaders?.['list-id'] as string | undefined) ?? '');
    if (!listId.includes(normalize(conditions.listIdContains))) {
      return false;
    }
  }

  return true;
};

export const evaluateRules = async (
  userId: string,
  incomingConnectorId: string,
  messageRow: {
    id: string;
    incomingConnectorId?: string;
    folderPath?: string;
    uid?: number;
    fromHeader: string | null;
    toHeader: string | null;
    subject: string | null;
    rawHeaders: Record<string, any> | null;
  },
  attachmentCount: number,
) => {
  const result = await query<{
    id: string;
    name: string;
    matching_scope: string;
    match_conditions: RuleMatch;
    actions: RuleAction;
  }>(
    `SELECT id, name, matching_scope, match_conditions, actions
     FROM rules
     WHERE is_active = true
       AND user_id = $1
       AND matching_scope = 'incoming'
     ORDER BY execution_order, created_at`,
    [userId],
  );

  for (const row of result.rows) {
    const rule: Rule = {
      id: row.id,
      name: row.name,
      matchingScope: row.matching_scope,
      matchConditions: row.match_conditions as RuleMatch,
      actions: row.actions as RuleAction,
    };

    const matches = await matchRule(rule, {
      fromHeader: messageRow.fromHeader,
      toHeader: messageRow.toHeader,
      subject: messageRow.subject,
      messageId: messageRow.id,
      incomingConnectorId: messageRow.incomingConnectorId,
      folderPath: messageRow.folderPath,
      uid: messageRow.uid,
      rawHeaders: messageRow.rawHeaders,
    }, attachmentCount);

    if (!matches) {
      continue;
    }
    const connectorId = messageRow.incomingConnectorId;
    const hasImapContext = Boolean(
      connectorId && messageRow.folderPath && messageRow.uid !== undefined && messageRow.uid !== null,
    );
    const folderPath = messageRow.folderPath as string | undefined;
    const uid = messageRow.uid as number | null | undefined;

    if (rule.actions.markRead) {
      if (hasImapContext && connectorId && folderPath && uid !== undefined && uid !== null) {
        await setMessageReadState(userId, messageRow.id, connectorId, folderPath, uid, true);
      } else {
        await query(
          `UPDATE messages m
           SET is_read = true
           FROM incoming_connectors ic
           WHERE m.id = $1 AND ic.id = m.incoming_connector_id AND ic.user_id = $2`,
          [messageRow.id, userId],
        );
      }
    }

    if (rule.actions.markUnread) {
      if (hasImapContext && connectorId && folderPath && uid !== undefined && uid !== null) {
        await setMessageReadState(userId, messageRow.id, connectorId, folderPath, uid, false);
      } else {
        await query(
          `UPDATE messages m
           SET is_read = false
           FROM incoming_connectors ic
           WHERE m.id = $1 AND ic.id = m.incoming_connector_id AND ic.user_id = $2`,
          [messageRow.id, userId],
        );
      }
    }

    if (rule.actions.star) {
      if (hasImapContext && connectorId && folderPath && uid !== undefined && uid !== null) {
        await setMessageStarredState(userId, messageRow.id, connectorId, folderPath, uid, true);
      } else {
        await query(
          `UPDATE messages m
           SET is_starred = true
           FROM incoming_connectors ic
           WHERE m.id = $1 AND ic.id = m.incoming_connector_id AND ic.user_id = $2`,
          [messageRow.id, userId],
        );
      }
    }

    if (rule.actions.moveToFolder) {
      if (hasImapContext && connectorId && folderPath && uid !== undefined && uid !== null) {
        await moveMessageInMailbox(
          userId,
          messageRow.id,
          connectorId,
          folderPath,
          rule.actions.moveToFolder,
          uid!,
        );
      } else {
        await query(
          `UPDATE messages m
           SET folder_path = $2
           FROM incoming_connectors ic
           WHERE m.id = $1 AND ic.id = m.incoming_connector_id AND ic.user_id = $3`,
          [messageRow.id, rule.actions.moveToFolder, userId],
        );
      }
    }

    if (rule.actions.notify) {
      await query(
        `INSERT INTO sync_events (incoming_connector_id, event_type, payload)
         VALUES ($1, 'rule_triggered', $2::jsonb)`,
        [incomingConnectorId, JSON.stringify({
          messageId: messageRow.id,
          ruleId: rule.id,
          title: rule.actions.notify.title ?? rule.name,
          body: rule.actions.notify.body ?? 'Rule matched',
        })],
      );
    }
  }
};

export const createRule = async (
  userId: string,
  payload: {
    name: string;
    matchingScope?: string;
    matchConditions: RuleMatch;
    actions: RuleAction;
    executionOrder?: number;
  },
) => {
  const result = await query<{ id: string }>(
    `INSERT INTO rules (user_id, name, matching_scope, match_conditions, actions, execution_order)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
     RETURNING id`,
    [
      userId,
      payload.name,
      payload.matchingScope ?? 'incoming',
      JSON.stringify(payload.matchConditions ?? {}),
      JSON.stringify(payload.actions ?? {}),
      payload.executionOrder ?? 0,
    ],
  );
  return result.rows[0];
};

export const listRules = async (userId: string) => {
  const result = await query<any>('SELECT * FROM rules WHERE user_id = $1 ORDER BY execution_order, created_at DESC', [userId]);
  return result.rows;
};

export const getRule = async (userId: string, id: string) => {
  const result = await query<any>('SELECT * FROM rules WHERE id = $1 AND user_id = $2', [id, userId]);
  return result.rows[0] ?? null;
};

export const deleteRule = async (userId: string, id: string) => {
  await query('DELETE FROM rules WHERE id = $1 AND user_id = $2', [id, userId]);
};
