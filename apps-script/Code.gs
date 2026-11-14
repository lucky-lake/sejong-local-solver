/**
 * 세종 로컬 해결소(가칭) 시연용 Apps Script 웹앱 (SPEC 3-3, 3-3b)
 *
 * doPost  {action:"save",  record}  접수 한 건 저장
 *         {action:"reset", key}     시연 데이터 비우기 (관리자 키 필요)
 * doGet   ?action=summary           집계 JSON (고민 원문·매장명은 보내지 않음)
 *
 * 관리자 키는 이 파일에 적지 않는다.
 * [프로젝트 설정] → [스크립트 속성]에 ADMIN_KEY 라는 이름으로만 저장한다.
 */

const SHEET_NAME = '접수';
// 1행 머리글. 값은 열 위치가 아니라 이 이름으로 찾아 넣는다(이미 만든 시트에 열을 끼워 넣어도 안 깨지게).
const HEADERS = [
  'id', '접수시각', '매장명', '업종', '지역', '운영기간', '고민상태', '고민원문', '진단답',
  '1순위유형', '1순위점수', '2순위유형', '추천전공', '기관연결필요', '출처',
];
const STORE_HEADER = '매장명';
const STORE_COLUMN = 3; // 이미 있는 시트에 매장명이 없으면 C열에 끼워 넣는다.
const MAX_TEXT_LENGTH = 200;
const MAX_STORE_LENGTH = 30;
const RECENT_COUNT = 10;
const LOCK_WAIT_MS = 10000;
const SUMMARY_CACHE_KEY = 'summary-v2';
const SUMMARY_CACHE_SECONDS = 2;

// 화면(js/app.js, data/categories.json)에 있는 값만 받는다.
const ALLOWED = {
  industry: ['카페·디저트', '음식점', '소매', '서비스(미용·학원 등)', '기타'],
  area: ['조치원읍', '신도심', '면 지역'],
  years: ['1년 미만', '1~3년', '3년 이상'],
  concernState: ['known', 'direction', 'unknown'],
  category: ['promo', 'menu', 'ops', 'booking', 'design', 'customer', 'funding'],
  major: ['경영·사회', 'IT·이공', '디자인·예체능'],
  diag: [
    ['늘었다', '비슷', '줄었다'],
    ['새 손님이 안 온다', '단골이 줄었다', '일이 너무 많다', '돈 관리가 어렵다'],
    ['예', '일부', '모름'],
    ['있다', '없다', '몰랐다'],
  ],
};

// 원문·매장명은 시트에만 남지만, 장난 입력과 연락처는 저장 전에 가린다.
const BANNED_WORDS = ['씨발', '시발', 'ㅅㅂ', '병신', 'ㅂㅅ', '개새', '좆', '존나', 'fuck', 'shit'];
const PHONE_PATTERN = /01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/g;
const ID_PATTERN = /^[a-z0-9-]{4,40}$/;

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action && action !== 'summary') return json_({ ok: false, error: 'unknown_action' });
  return json_({ ok: true, summary: getSummary_() });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }
  if (body && body.action === 'save') return json_(save_(body.record));
  if (body && body.action === 'reset') return json_(reset_(body.key));
  return json_({ ok: false, error: 'unknown_action' });
}

/** 편집기에서 실행한다. 권한을 승인하고 '접수' 탭과 머리글을 만들거나, 빠진 머리글을 채운다. */
function setup() {
  getSheet_();
}

function getSheet_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = book.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    return sheet;
  }
  const present = headerRow_(sheet);
  if (present.indexOf(STORE_HEADER) === -1) {
    sheet.insertColumnBefore(STORE_COLUMN);
    sheet.getRange(1, STORE_COLUMN).setValue(STORE_HEADER);
  }
  const now = headerRow_(sheet);
  HEADERS.filter((name) => now.indexOf(name) === -1).forEach((name) => {
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue(name);
  });
  return sheet;
}

function headerRow_(sheet) {
  const width = Math.max(sheet.getLastColumn(), 1);
  return sheet.getRange(1, 1, 1, width).getValues()[0].map((value) => String(value).trim());
}

// 머리글 이름 → 열 번호(0부터)
function headerIndex_(sheet) {
  const index = {};
  headerRow_(sheet).forEach((name, i) => {
    if (name && !(name in index)) index[name] = i;
  });
  return index;
}

function save_(raw) {
  const record = cleanRecord_(raw);
  if (!record) return { ok: false, error: 'invalid_record' };

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_WAIT_MS);
  } catch (err) {
    return { ok: false, error: 'busy' };
  }
  try {
    const sheet = getSheet_();
    const index = headerIndex_(sheet);
    // 응답을 못 받은 기기가 다시 보내도 한 번만 센다.
    if (hasId_(sheet, index, record.id)) return { ok: true, duplicate: true };
    sheet.appendRow(toRow_(record, new Date().toISOString(), index, sheet.getLastColumn()));
    CacheService.getScriptCache().remove(SUMMARY_CACHE_KEY);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function reset_(key) {
  const expected = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  if (!expected) return { ok: false, error: 'no_admin_key' };
  if (String(key || '') !== expected) {
    Utilities.sleep(1000);
    return { ok: false, error: 'forbidden' };
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_WAIT_MS);
  } catch (err) {
    return { ok: false, error: 'busy' };
  }
  try {
    const sheet = getSheet_();
    const last = sheet.getLastRow();
    if (last > 1) sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).clearContent();
    CacheService.getScriptCache().remove(SUMMARY_CACHE_KEY);
    return { ok: true, cleared: Math.max(last - 1, 0) };
  } finally {
    lock.releaseLock();
  }
}

function getSummary_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(SUMMARY_CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const sheet = getSheet_();
  const index = headerIndex_(sheet);
  const values = sheet.getDataRange().getValues();
  const cell = (row, name) => (name in index ? row[index[name]] : '');
  // 집계에 필요한 칸만 꺼낸다. 고민원문·매장명 칸은 읽지 않는다.
  const records = values.slice(1)
    .filter((row) => cell(row, 'id'))
    .map((row) => {
      const agency = cell(row, '기관연결필요');
      const category = cell(row, '1순위유형');
      return {
        id: String(cell(row, 'id')),
        ts: toIso_(cell(row, '접수시각')),
        industry: cell(row, '업종'),
        area: cell(row, '지역'),
        concernState: cell(row, '고민상태'),
        categories: category ? [{ id: category }] : [],
        needsAgency: agency === true || String(agency).toUpperCase() === 'TRUE',
        source: 'live',
      };
    });

  const summary = summarize_(records);
  cache.put(SUMMARY_CACHE_KEY, JSON.stringify(summary), SUMMARY_CACHE_SECONDS);
  return summary;
}

// js/dashboard.js 의 summarize()와 같은 규칙으로 센다. 최근 10건에는 새 접수 알림용 id와 서버가 받은 시각을 넣는다.
function summarize_(records) {
  const summary = {
    total: 0,
    needsAgency: 0,
    byCategory: {},
    byArea: {},
    byIndustry: {},
    byState: {},
    areaCategory: {},
    recent: [],
  };
  records.forEach((record) => {
    const category = record.categories && record.categories[0] ? record.categories[0].id : null;
    summary.total += 1;
    if (record.needsAgency) summary.needsAgency += 1;
    add_(summary.byCategory, category);
    add_(summary.byArea, record.area);
    add_(summary.byIndustry, record.industry);
    add_(summary.byState, record.concernState);
    if (record.area && category) {
      summary.areaCategory[record.area] = summary.areaCategory[record.area] || {};
      add_(summary.areaCategory[record.area], category);
    }
  });
  summary.recent = records
    .slice()
    .sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0))
    .slice(0, RECENT_COUNT)
    .map((record) => ({
      id: record.id,
      ts: record.ts,
      industry: record.industry,
      area: record.area,
      category: record.categories && record.categories[0] ? record.categories[0].id : null,
      concernState: record.concernState,
      needsAgency: record.needsAgency,
      source: record.source,
    }));
  return summary;
}

function add_(bucket, key) {
  if (key) bucket[key] = (bucket[key] || 0) + 1;
}

function cleanRecord_(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  if (!ID_PATTERN.test(id)) return null;

  const industry = pick_(raw.industry, ALLOWED.industry);
  const area = pick_(raw.area, ALLOWED.area);
  // 운영 기간은 확정 디자인(R3) 체험에서 묻지 않아 비어 올 수 있다.
  const years = pick_(raw.years, ALLOWED.years);
  const concernState = pick_(raw.concernState, ALLOWED.concernState);
  const categories = (Array.isArray(raw.categories) ? raw.categories : [])
    .filter((item) => item && ALLOWED.category.indexOf(item.id) !== -1)
    .slice(0, 2)
    .map((item) => ({ id: item.id, score: Number(item.score) || 0 }));
  if (!industry || !area || !concernState || categories.length === 0) return null;

  return {
    id,
    storeName: cleanText_(raw.storeName, MAX_STORE_LENGTH),
    industry,
    area,
    years,
    concernState,
    text: concernState === 'unknown' ? '' : cleanText_(raw.text, MAX_TEXT_LENGTH),
    diag: ALLOWED.diag.map((options, index) => pick_(raw.diag && raw.diag[index], options)).filter(Boolean),
    categories,
    majors: (Array.isArray(raw.majors) ? raw.majors : [])
      .filter((major) => ALLOWED.major.indexOf(major) !== -1)
      .slice(0, 3),
    needsAgency: raw.needsAgency === true,
    source: 'live',
  };
}

// 앞뒤 공백 제거 → 길이 자르기 → 연락처·금칙어 가리기 → 수식처럼 시작하면 앞에 ' 붙이기
function cleanText_(value, maxLength) {
  let text = String(value || '').trim().slice(0, maxLength).replace(PHONE_PATTERN, '[번호 삭제]');
  const squashed = text.replace(/\s+/g, '').toLowerCase();
  if (BANNED_WORDS.some((word) => squashed.indexOf(word) !== -1)) text = '[금칙어로 가림]';
  // =, +, -, @ 로 시작하면 시트가 수식으로 실행하지 않게 앞에 '를 붙인다.
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return text;
}

function toRow_(record, receivedAt, index, width) {
  const [first, second] = record.categories;
  const values = {
    id: record.id,
    접수시각: receivedAt,
    매장명: record.storeName,
    업종: record.industry,
    지역: record.area,
    운영기간: record.years || '',
    고민상태: record.concernState,
    고민원문: record.text,
    진단답: record.diag.join(', '),
    '1순위유형': first.id,
    '1순위점수': first.score,
    '2순위유형': second ? second.id : '',
    추천전공: record.majors.join(', '),
    기관연결필요: record.needsAgency,
    출처: record.source,
  };
  const row = new Array(Math.max(width, HEADERS.length)).fill('');
  Object.keys(values).forEach((name) => {
    if (name in index) row[index[name]] = values[name];
  });
  return row;
}

function hasId_(sheet, index, id) {
  const last = sheet.getLastRow();
  if (last < 2 || !('id' in index)) return false;
  return sheet.getRange(2, index.id + 1, last - 1, 1).getValues().some((row) => String(row[0]) === id);
}

function pick_(value, options) {
  return options.indexOf(value) !== -1 ? value : null;
}

function toIso_(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || '');
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
