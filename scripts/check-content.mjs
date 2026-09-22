import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_VERSION = '2026-09-22.1';
const QUESTION_IDS = Array.from(
  { length: 20 },
  (_, index) => `Q${String(index + 1).padStart(2, '0')}`,
);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function requireKeys(value, expected, location) {
  requireCondition(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${location}: 객체가 필요합니다.`,
  );
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  requireCondition(
    actualKeys.length === expectedKeys.length &&
      actualKeys.every((key, index) => key === expectedKeys[index]),
    `${location}: 허용된 필드만 정확히 포함해야 합니다 (${expected.join(', ')}).`,
  );
}

function sourceRows(markdown, sectionNumber, columns) {
  const lines = markdown.split(/\r?\n/);
  const headingPattern = new RegExp(`^## ${sectionNumber}\\. `);
  const headings = lines.flatMap((line, index) =>
    headingPattern.test(line) ? [index] : [],
  );
  requireCondition(headings.length === 1, `원문 §${sectionNumber}: 절이 하나여야 합니다.`);
  const start = headings[0] + 1;
  const followingHeading = lines.findIndex(
    (line, index) => index >= start && /^## /.test(line),
  );
  const section = lines.slice(start, followingHeading === -1 ? undefined : followingHeading);
  const rows = section.filter((line) => /^\|\s*Q/.test(line)).map((line) => {
    requireCondition(line.endsWith('|'), `원문 §${sectionNumber}: 표 행이 올바르지 않습니다.`);
    // Markdown 표의 셀 여백만 제거한다. 문구의 내부 공백·문장부호·Unicode는 바꾸지 않는다.
    const cells = line.slice(1, -1).split('|').map((cell) => cell.trim());
    requireCondition(cells.length === columns, `원문 §${sectionNumber}: 열 수가 올바르지 않습니다.`);
    requireCondition(cells.every((cell) => cell.length > 0), `원문 §${sectionNumber}: 빈 셀이 있습니다.`);
    return cells;
  });
  requireCondition(rows.length === QUESTION_IDS.length, `원문 §${sectionNumber}: 20개 문항이 필요합니다.`);
  rows.forEach((row, index) => {
    requireCondition(row[0] === QUESTION_IDS[index], `원문 §${sectionNumber}: Q01~Q20 순서가 필요합니다.`);
  });
  return rows;
}

function requireExactText(actual, expected, location) {
  requireCondition(typeof actual === 'string' && actual.length > 0, `${location}: 빈 문자열은 허용하지 않습니다.`);
  requireCondition(
    Buffer.from(actual, 'utf8').equals(Buffer.from(expected, 'utf8')),
    `${location}: 원문과 UTF-8 바이트가 일치하지 않습니다.`,
  );
}

export function validateCatalog(catalog, sourceMarkdown) {
  requireKeys(catalog, ['contentVersion', 'questions'], 'catalog');
  requireCondition(catalog.contentVersion === EXPECTED_VERSION, 'contentVersion이 지정 버전과 다릅니다.');
  requireCondition(Array.isArray(catalog.questions), 'questions 배열이 필요합니다.');
  requireCondition(catalog.questions.length === QUESTION_IDS.length, '문항 수는 정확히 20개여야 합니다.');

  const questions = sourceRows(sourceMarkdown, 2, 4);
  const followUps = sourceRows(sourceMarkdown, 4, 2);

  catalog.questions.forEach((question, index) => {
    const id = QUESTION_IDS[index];
    requireKeys(question, ['id', 'category', 'options', 'followUp'], `questions[${index}]`);
    requireCondition(question.id === id, `questions[${index}]: Q01~Q20 연속 순서와 고유 ID가 필요합니다.`);
    requireKeys(question.options, ['A', 'B'], `${id}.options`);
    requireExactText(question.category, questions[index][1], `${id}.category`);
    requireExactText(question.options.A, questions[index][2], `${id}.options.A`);
    requireExactText(question.options.B, questions[index][3], `${id}.options.B`);
    requireExactText(question.followUp, followUps[index][1], `${id}.followUp`);
  });

  return { questionCount: QUESTION_IDS.length, matchedTextFields: QUESTION_IDS.length * 4 };
}

async function main() {
  const [sourceMarkdown, catalogText] = await Promise.all([
    readFile(new URL('../docs/profile-questions.md', import.meta.url), 'utf8'),
    readFile(new URL('../src/content/questions.v2.json', import.meta.url), 'utf8'),
  ]);
  const result = validateCatalog(JSON.parse(catalogText), sourceMarkdown);
  console.log(
    `콘텐츠 검증 통과: ${result.questionCount}문항, 원문 ${result.matchedTextFields}개 문구 UTF-8 일치, ` +
      'Q01~Q20 순서·A/B 선택지·필드 허용 목록 확인.',
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`콘텐츠 검증 실패: ${error.message}`);
    process.exitCode = 1;
  });
}
