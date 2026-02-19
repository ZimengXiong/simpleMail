import { query } from '../db/pool.js';
import {
  applyThreadMessageActions,
  moveMessageInMailbox,
  deleteMessageFromMailbox,
  setMessageReadState,
  setMessageStarredState,
} from './imap.js';
import { addLabelsToMessageByKey, removeLabelsFromMessageByKey } from './labels.js';

export interface RuleMatch {
  fromContains?: string;
  toContains?: string;
  subjectContains?: string;
  isUnread?: boolean;
  isStarred?: boolean;
  hasLabel?: string[];
  notHasLabel?: string[];
  hasAttachment?: boolean;
  listIdContains?: string;
}

export interface RuleAction {
  markRead?: boolean;
  star?: boolean;
  addLabelKeys?: string[];
  removeLabelKeys?: string[];
  markUnread?: boolean;
  moveToFolder?: string;
  applyToThread?: boolean;
  delete?: boolean;
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
  isRead: boolean;
  isStarred: boolean;
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

  if (typeof conditions.isUnread === 'boolean') {
    if (conditions.isUnread && message.isRead) {
      return false;
    }
    if (!conditions.isUnread && !message.isRead) {
      return false;
    }
  }

  if (typeof conditions.isStarred === 'boolean' && message.isStarred !== conditions.isStarred) {
    return false;
  }

  const hasLabels = message.rawHeaders?.labels ?? null;
  const hasLabelList = Array.isArray(conditions.hasLabel) ? conditions.hasLabel : [];
  if (hasLabelList.length > 0) {
    for (const label of hasLabelList) {
      if (!hasLabels?.includes?.(label)) {
        return false;
      }
    }
  }

  const notHasLabelList = Array.isArray(conditions.notHasLabel) ? conditions.notHasLabel : [];
  if (notHasLabelList.length > 0) {
    for (const label of notHasLabelList) {
      if (hasLabels?.includes?.(label)) {
        return false;
      }
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
    uid?: number | null;
    fromHeader: string | null;
    toHeader: string | null;
    subject: string | null;
    isRead?: boolean;
    isStarred?: boolean;
    rawHeaders: Record<string, any> | null;
  },
  attachmentCount: number,
  ruleId?: string,
) => {
  const filterClause = ruleId ? ' AND id = $2' : '';
  const values = ruleId ? [userId, ruleId] : [userId];

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
       ${filterClause}
     ORDER BY execution_order, created_at`,
    values,
  );

  let matched = 0;
  for (const row of result.rows) {
    const rule: Rule = {
      id: row.id,
      name: row.name,
      matchingScope: row.matching_scope,
      matchConditions: row.match_conditions as RuleMatch,
      actions: row.actions as RuleAction,
    };

    const labelRows = await query<{ key: string }>(
      `SELECT l.key
         FROM message_labels ml
         INNER JOIN labels l ON l.id = ml.label_id
        WHERE ml.message_id = $1`,
      [messageRow.id],
    );

    const messageForEvaluation = {
      messageId: messageRow.id,
      incomingConnectorId: messageRow.incomingConnectorId,
      folderPath: messageRow.folderPath,
      uid: messageRow.uid,
      fromHeader: messageRow.fromHeader,
      toHeader: messageRow.toHeader,
      subject: messageRow.subject,
      isRead: messageRow.isRead ?? true,
      isStarred: messageRow.isStarred ?? false,
      rawHeaders: {
        ...(messageRow.rawHeaders ?? {}),
        labels: labelRows.rows.map((item) => item.key),
      },
    };

    const matches = await matchRule(rule, messageForEvaluation, attachmentCount);

    if (!matches) {
      continue;
    }
    matched += 1;
    const connectorId = messageForEvaluation.incomingConnectorId;
    const hasImapContext = Boolean(
      connectorId && messageForEvaluation.folderPath && messageForEvaluation.uid !== undefined && messageForEvaluation.uid !== null,
    );
    const folderPath = messageForEvaluation.folderPath as string | undefined;
    const uid = messageForEvaluation.uid as number | null | undefined;

    if (rule.actions.applyToThread) {
      await applyThreadMessageActions(userId, messageRow.id, {
        isRead: rule.actions.markRead ? true : rule.actions.markUnread ? false : undefined,
        isStarred: rule.actions.star ? true : undefined,
        moveToFolder: rule.actions.moveToFolder,
        delete: Boolean(rule.actions.delete),
        addLabelKeys: rule.actions.addLabelKeys,
        removeLabelKeys: rule.actions.removeLabelKeys,
      });
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
      continue;
    }

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

    if (rule.actions.addLabelKeys?.length) {
      await addLabelsToMessageByKey(
        userId,
        messageRow.id,
        rule.actions.addLabelKeys,
      );
    }

    if (rule.actions.removeLabelKeys?.length) {
      await removeLabelsFromMessageByKey(
        userId,
        messageRow.id,
        rule.actions.removeLabelKeys,
      );
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

    if (rule.actions.delete) {
      if (hasImapContext && connectorId && folderPath && uid !== undefined && uid !== null) {
        await deleteMessageFromMailbox(
          userId,
          messageRow.id,
          connectorId,
          folderPath,
          uid,
        );
      } else {
        await query(
          'DELETE FROM messages WHERE id = $1',
          [messageRow.id],
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

  return matched;
};

export const runRulesAgainstMessages = async (
  userId: string,
  options?: {
    ruleId?: string;
    incomingConnectorId?: string;
    limit?: number;
    offset?: number;
  },
) => {
  const payload = options ?? {};
  const requestedLimit = payload.limit ?? 300;
  const requestedOffset = payload.offset ?? 0;
  const batchLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 300;
  let offset = Number.isFinite(requestedOffset) && requestedOffset >= 0 ? Math.floor(requestedOffset) : 0;
  let processed = 0;
  let matched = 0;

  const whereClauses = ['ic.user_id = $1'];
  const values: any[] = [userId];
  if (payload.incomingConnectorId) {
    values.push(payload.incomingConnectorId);
    whereClauses.push(`ic.id = $${values.length}`);
  }
  if (payload.ruleId && !(await query<{ id: string }>(`
    SELECT id
      FROM rules
     WHERE id = $2
       AND user_id = $1
       AND is_active = true
  `, [userId, payload.ruleId])).rows.length) {
    throw new Error('Rule not found');
  }

  while (true) {
    const messages = await query<{
      id: string;
      incoming_connector_id: string;
      folder_path: string | null;
      uid: number | null;
      from_header: string | null;
      to_header: string | null;
      subject: string | null;
      is_read: boolean;
      is_starred: boolean;
      raw_headers: Record<string, any> | null;
    }>(
      `SELECT m.id, m.incoming_connector_id, m.folder_path, m.uid, m.from_header, m.to_header, m.subject, m.is_read, m.is_starred, m.raw_headers
         FROM messages m
         INNER JOIN incoming_connectors ic ON ic.id = m.incoming_connector_id
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY m.received_at DESC
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, batchLimit, offset],
    );

    if (messages.rows.length === 0) {
      break;
    }

    for (const message of messages.rows) {
      const labelsResult = await query<{ key: string }>(
        `SELECT l.key
           FROM message_labels ml
           INNER JOIN labels l ON l.id = ml.label_id
          WHERE ml.message_id = $1`,
        [message.id],
      );

      const attachmentResult = await query<{ count: number }>(
        `SELECT COUNT(*)::int as count FROM attachments WHERE message_id = $1`,
        [message.id],
      );

      const attachmentCount = Number(attachmentResult.rows[0]?.count ?? 0);

      const messageForEvaluation = {
        id: message.id,
        incomingConnectorId: message.incoming_connector_id,
        folderPath: message.folder_path ?? undefined,
        uid: message.uid ?? null,
        fromHeader: message.from_header,
        toHeader: message.to_header,
        subject: message.subject,
        isRead: message.is_read,
        isStarred: message.is_starred,
        rawHeaders: {
          ...(message.raw_headers ?? {}),
          labels: labelsResult.rows.map((item) => item.key),
        },
      };

      const matchedForMessage = await evaluateRules(
        userId,
        message.incoming_connector_id,
        messageForEvaluation,
        attachmentCount,
        payload.ruleId,
      );

      if (matchedForMessage > 0) {
        matched += matchedForMessage;
      }

      processed += 1;
    }

    if (messages.rows.length < batchLimit) {
      break;
    }
    offset += batchLimit;
  }

  return { processed, matched };
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
