export interface ParsedMessageSearch {
  rawQuery: string;
  freeTerms: string[];
  freeNegatedTerms: string[];
  fromTerms: string[];
  fromNegatedTerms: string[];
  toTerms: string[];
  toNegatedTerms: string[];
  subjectTerms: string[];
  subjectNegatedTerms: string[];
  labelIncludes: string[];
  labelExcludes: string[];
  hasAttachment?: boolean;
  hasNoAttachment?: boolean;
  hasStarred?: boolean;
  isUnread?: boolean;
  isRead?: boolean;
  dateAfter?: string;
  dateBefore?: string;
  dateAfterExcludes: string[];
  dateBeforeExcludes: string[];
}

type ParsedSearchTerm = {
  negated: boolean;
  field: string;
  value: string;
};

const splitTerms = (input: string): string[] => {
  const terms: string[] = [];
  let current = '';
  let inQuote = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      inQuote = !inQuote;
      current += char;
      continue;
    }

    if (!inQuote && /\s/.test(char)) {
      if (current) {
        terms.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    terms.push(current);
  }
  return terms;
};

const unquote = (value: string) => value.replace(/^"|"$/g, '').trim();

const parseOperatorTerm = (token: string): ParsedSearchTerm | null => {
  if (!token.includes(':')) {
    return null;
  }

  const negated = token.startsWith('-');
  const working = negated ? token.slice(1) : token;
  const separator = working.indexOf(':');
  if (separator <= 0) {
    return null;
  }

  const field = working.slice(0, separator).toLowerCase().trim();
  const value = unquote(working.slice(separator + 1).trim());
  if (!field || !value) {
    return null;
  }

  if (!['from', 'to', 'subject', 'label', 'has', 'before', 'after', 'is'].includes(field)) {
    return null;
  }

  return { negated, field, value };
};

const parseDateValue = (input: string): string | null => {
  const value = input.trim();
  if (!value) {
    return null;
  }

  const relativeDays = /^(\d+)d$/i.exec(value);
  if (relativeDays?.[1]) {
    const days = Number(relativeDays[1]);
    if (Number.isFinite(days)) {
      const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      return date.toISOString();
    }
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
};

export const parseMessageSearchQuery = (query: string): ParsedMessageSearch => {
  const result: ParsedMessageSearch = {
    rawQuery: query,
    freeTerms: [],
    freeNegatedTerms: [],
    fromTerms: [],
    fromNegatedTerms: [],
    toTerms: [],
    toNegatedTerms: [],
    subjectTerms: [],
    subjectNegatedTerms: [],
    labelIncludes: [],
    labelExcludes: [],
    dateAfterExcludes: [],
    dateBeforeExcludes: [],
  };

  for (const token of splitTerms(query)) {
    const parsed = parseOperatorTerm(token);
    if (!parsed) {
      const safe = unquote(token);
      if (!safe) {
        continue;
      }
      if (safe.startsWith('-')) {
        result.freeNegatedTerms.push(safe.slice(1));
      } else {
        result.freeTerms.push(safe);
      }
      continue;
    }

    if (parsed.field === 'from') {
      if (parsed.negated) {
        result.fromNegatedTerms.push(parsed.value);
      } else {
        result.fromTerms.push(parsed.value);
      }
      continue;
    }

    if (parsed.field === 'to') {
      if (parsed.negated) {
        result.toNegatedTerms.push(parsed.value);
      } else {
        result.toTerms.push(parsed.value);
      }
      continue;
    }

    if (parsed.field === 'subject') {
      if (parsed.negated) {
        result.subjectNegatedTerms.push(parsed.value);
      } else {
        result.subjectTerms.push(parsed.value);
      }
      continue;
    }

    if (parsed.field === 'label') {
      if (parsed.negated) {
        result.labelExcludes.push(parsed.value.toLowerCase());
      } else {
        result.labelIncludes.push(parsed.value.toLowerCase());
      }
      continue;
    }

    if (parsed.field === 'has') {
      const value = parsed.value.toLowerCase();
      if (value === 'attachment') {
        if (parsed.negated) {
          result.hasNoAttachment = true;
        } else {
          result.hasAttachment = true;
        }
      } else if (value === 'star') {
        if (parsed.negated) {
          result.hasStarred = false;
        } else {
          result.hasStarred = true;
        }
      } else if (value === 'starred') {
        result.hasStarred = !parsed.negated;
      }
      continue;
    }

    if (parsed.field === 'before') {
      const parsedDate = parseDateValue(parsed.value);
      if (!parsedDate) {
        continue;
      }
      if (parsed.negated) {
        result.dateBeforeExcludes.push(parsedDate);
      } else {
        result.dateBefore = parsedDate;
      }
      continue;
    }

    if (parsed.field === 'after') {
      const parsedDate = parseDateValue(parsed.value);
      if (!parsedDate) {
        continue;
      }
      if (parsed.negated) {
        result.dateAfterExcludes.push(parsedDate);
      } else {
        result.dateAfter = parsedDate;
      }
      continue;
    }

    if (parsed.field === 'is') {
      const value = parsed.value.toLowerCase();
      if (value === 'unread' || value === 'read') {
        if (parsed.negated) {
          result.isRead = value === 'unread';
          result.isUnread = value === 'read';
        } else {
          result.isUnread = value === 'unread';
          result.isRead = value === 'read';
        }
        continue;
      }

      if (value === 'starred') {
        result.hasStarred = !parsed.negated;
      }
      continue;
    }
  }

  return result;
};

const buildLikeClause = (
  column: string,
  positiveTerms: string[],
  negativeTerms: string[],
  start: number,
): { clause: string; values: string[]; nextIndex: number } => {
  const values: string[] = [];
  const clauses: string[] = [];
  let nextIndex = start;

  if (positiveTerms.length > 0) {
    const orTerms = positiveTerms
      .map((term) => {
        values.push(`%${term.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`);
        nextIndex += 1;
        return `lower(${column}) LIKE lower($${nextIndex}) ESCAPE '\\'`;
      })
      .join(' OR ');
    clauses.push(`(${orTerms})`);
  }

  if (negativeTerms.length > 0) {
    const andTerms = negativeTerms
      .map((term) => {
        values.push(`%${term.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`);
        nextIndex += 1;
        return `lower(${column}) NOT LIKE lower($${nextIndex}) ESCAPE '\\'`;
      })
      .join(' AND ');
    clauses.push(`(${andTerms})`);
  }

  return {
    clause: clauses.join(' AND '),
    values,
    nextIndex,
  };
};

export const buildMessageSearchQuery = (userId: string, parsed: ParsedMessageSearch) => {
  const values: any[] = [userId];
  const predicates: string[] = ['ic.user_id = $1'];

  if (parsed.labelIncludes.length > 0) {
    for (const label of parsed.labelIncludes) {
      const paramIndex = values.length + 1;
      values.push(label);
      predicates.push(
        `EXISTS (
           SELECT 1
             FROM message_labels ml
             INNER JOIN labels l ON l.id = ml.label_id
            WHERE ml.message_id = m.id
              AND l.user_id = $1
              AND l.key = $${paramIndex}
         )`,
      );
    }
  }

  if (parsed.labelExcludes.length > 0) {
    for (const label of parsed.labelExcludes) {
      const paramIndex = values.length + 1;
      values.push(label);
      predicates.push(
        `NOT EXISTS (
           SELECT 1
             FROM message_labels ml
             INNER JOIN labels l ON l.id = ml.label_id
            WHERE ml.message_id = m.id
              AND l.user_id = $1
              AND l.key = $${paramIndex}
         )`,
      );
    }
  }

  if (parsed.dateAfter) {
    const paramIndex = values.length + 1;
    values.push(parsed.dateAfter);
    predicates.push(`m.received_at >= $${paramIndex}::timestamptz`);
  }

  if (parsed.dateBefore) {
    const paramIndex = values.length + 1;
    values.push(parsed.dateBefore);
    predicates.push(`m.received_at < $${paramIndex}::timestamptz`);
  }

  for (const dateAfterExclude of parsed.dateAfterExcludes ?? []) {
    const paramIndex = values.length + 1;
    values.push(dateAfterExclude);
    predicates.push(`m.received_at < $${paramIndex}::timestamptz`);
  }

  for (const dateBeforeExclude of parsed.dateBeforeExcludes ?? []) {
    const paramIndex = values.length + 1;
    values.push(dateBeforeExclude);
    predicates.push(`m.received_at >= $${paramIndex}::timestamptz`);
  }

  if (typeof parsed.hasAttachment === 'boolean') {
    if (parsed.hasAttachment) {
      predicates.push(`EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)`);
    }
  }

  if (typeof parsed.hasNoAttachment === 'boolean' && parsed.hasNoAttachment && !parsed.hasAttachment) {
    predicates.push(`NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)`);
  } else if (typeof parsed.hasAttachment === 'boolean' && !parsed.hasAttachment) {
    predicates.push(`NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)`);
  }

  if (typeof parsed.hasStarred === 'boolean') {
    predicates.push(`m.is_starred = ${parsed.hasStarred ? 'TRUE' : 'FALSE'}`);
  }

  if (typeof parsed.isUnread === 'boolean' && parsed.isUnread) {
    predicates.push('m.is_read = FALSE');
  } else if (typeof parsed.isRead === 'boolean' && parsed.isRead) {
    predicates.push('m.is_read = TRUE');
  }

  const fromClause = buildLikeClause('m.from_header', parsed.fromTerms, parsed.fromNegatedTerms, values.length);
  if (fromClause.clause) {
    predicates.push(fromClause.clause);
    values.push(...fromClause.values);
  }

  const toClause = buildLikeClause('m.to_header', parsed.toTerms, parsed.toNegatedTerms, values.length);
  if (toClause.clause) {
    predicates.push(toClause.clause);
    values.push(...toClause.values);
  }

  const subjectClause = buildLikeClause('m.subject', parsed.subjectTerms, parsed.subjectNegatedTerms, values.length);
  if (subjectClause.clause) {
    predicates.push(subjectClause.clause);
    values.push(...subjectClause.values);
  }

  // Free-text: use the GIN-indexed tsvector exclusively — no LIKE scan.
  const textQuery = [...parsed.freeTerms, ...parsed.freeNegatedTerms.map((t) => `-${t}`)]
    .map((term) => term.trim())
    .filter(Boolean)
    .join(' ');

  // Field-operator tsvector terms (from:, to:, subject:) — build a compound
  // websearch_to_tsquery combining all terms so we get a single index seek.
  const fieldTextQuery = [...parsed.fromTerms, ...parsed.toTerms, ...parsed.subjectTerms]
    .map((term) => term.trim())
    .filter(Boolean)
    .join(' ');

  const combinedTextQuery = [textQuery, fieldTextQuery].filter(Boolean).join(' ');

  if (combinedTextQuery) {
    const textIndex = values.length + 1;
    values.push(combinedTextQuery);
    predicates.push(`(
      m.search_vector @@ websearch_to_tsquery('english', $${textIndex})
      OR EXISTS (
        SELECT 1
          FROM attachments a
         WHERE a.message_id = m.id
           AND (
             a.search_vector @@ websearch_to_tsquery('english', $${textIndex})
             OR lower(a.filename) LIKE concat('%', lower($${textIndex}), '%')
           )
      )
    )`);
  }

  return { predicates, values };
};
