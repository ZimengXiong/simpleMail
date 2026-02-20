import assert from 'node:assert/strict';
import { buildMessageSearchQuery, parseMessageSearchQuery, type ParsedMessageSearch } from '../search.js';

let passed = 0;
let failed = 0;

const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(`  ${error}`);
  }
};

const blankParsed = (): ParsedMessageSearch => ({
  rawQuery: '',
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
});

test('keeps base user predicate and user id parameter', () => {
  const { predicates, values } = buildMessageSearchQuery('user-123', blankParsed());
  assert.deepEqual(values, ['user-123']);
  assert.ok(predicates.includes('ic.user_id = $1'));
});

test('generates label include/exclude predicates with stable parameter ordering', () => {
  const parsed = parseMessageSearchQuery('label:work label:urgent -label:spam -label:trash');
  const { predicates, values } = buildMessageSearchQuery('user-1', parsed);

  const sql = predicates.join('\n');
  assert.match(sql, /EXISTS \([\s\S]*l\.key = \$2[\s\S]*\)/);
  assert.match(sql, /EXISTS \([\s\S]*l\.key = \$3[\s\S]*\)/);
  assert.match(sql, /NOT EXISTS \([\s\S]*l\.key = \$4[\s\S]*\)/);
  assert.match(sql, /NOT EXISTS \([\s\S]*l\.key = \$5[\s\S]*\)/);
  assert.deepEqual(values, ['user-1', 'work', 'urgent', 'spam', 'trash']);
});

test('escapes % and _ in LIKE terms for sender/recipient/subject fields', () => {
  const parsed = parseMessageSearchQuery('from:"100%_safe" to:"ops_%team" subject:"50%_done"');
  const { predicates, values } = buildMessageSearchQuery('user-2', parsed);

  const sql = predicates.join('\n');
  assert.match(sql, /lower\(m\.from_header\) LIKE lower\(\$2\) ESCAPE/);
  assert.match(sql, /lower\(m\.to_header\) LIKE lower\(\$3\) ESCAPE/);
  assert.match(sql, /lower\(m\.subject\) LIKE lower\(\$4\) ESCAPE/);
  assert.deepEqual(values, [
    'user-2',
    '%100\\%\\_safe%',
    '%ops\\_\\%team%',
    '%50\\%\\_done%',
    '100%_safe ops_%team 50%_done',
  ]);
});

test('builds attachment/star/read predicates correctly for mixed flags', () => {
  const parsed = parseMessageSearchQuery('has:attachment -has:attachment is:read is:starred');
  const { predicates } = buildMessageSearchQuery('user-3', parsed);
  const sql = predicates.join('\n');

  assert.match(sql, /EXISTS \(SELECT 1 FROM attachments a WHERE a\.message_id = m\.id\)/);
  assert.doesNotMatch(sql, /NOT EXISTS \(SELECT 1 FROM attachments a WHERE a\.message_id = m\.id\)/);
  assert.match(sql, /m\.is_starred = TRUE/);
  assert.match(sql, /m\.is_read = TRUE/);
});

test('generates date window predicates and negated date filters', () => {
  const parsed = parseMessageSearchQuery('after:2026-01-10 before:2026-01-20 -after:2026-01-15 -before:2026-01-05');
  const { predicates, values } = buildMessageSearchQuery('user-4', parsed);
  const sql = predicates.join('\n');

  assert.match(sql, /m\.received_at >= \$2::timestamptz/);
  assert.match(sql, /m\.received_at < \$3::timestamptz/);
  assert.match(sql, /m\.received_at < \$4::timestamptz/);
  assert.match(sql, /m\.received_at >= \$5::timestamptz/);
  assert.deepEqual(values, [
    'user-4',
    '2026-01-10T00:00:00.000Z',
    '2026-01-20T00:00:00.000Z',
    '2026-01-15T00:00:00.000Z',
    '2026-01-05T00:00:00.000Z',
  ]);
});

test('combines free terms, negated terms, and field terms into one text-search query parameter', () => {
  const parsed = parseMessageSearchQuery('roadmap -draft from:alice@example.com to:bob@example.com subject:"Q1 Plan"');
  const { predicates, values } = buildMessageSearchQuery('user-5', parsed);
  const sql = predicates.join('\n');

  assert.match(sql, /m\.search_vector @@ websearch_to_tsquery\('english', \$5\)/);
  assert.match(sql, /a\.search_vector @@ websearch_to_tsquery\('english', \$5\)/);
  assert.equal(values[4], 'roadmap -draft alice@example.com bob@example.com Q1 Plan');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
