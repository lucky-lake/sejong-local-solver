/**
 * 세종 로컬 해결소(가칭) 시연용 Apps Script 웹앱 (SPEC 3-3, 3-3b)
 *
 * doPost  {action:"save",   record}  사장님 접수 한 건 저장 ('접수' 탭)
 *         {action:"apply",  record}  학생 지원 한 건 저장 ('지원' 탭)
 *         {action:"cancel", id}      학생 지원 취소 표시
 *         {action:"reset",  key}     시연 데이터 비우기 (관리자 키 필요)
 * doGet   ?action=summary            집계 JSON (고민 원문·전화번호는 보내지 않음.
 *                                    매장명·위치는 발표 화면 알림에 쓰므로 최근 10건에만 넣는다)
 *
 * 관리자 키는 이 파일에 적지 않는다.
 * [프로젝트 설정] → [스크립트 속성]에 ADMIN_KEY 라는 이름으로만 저장한다.
 */

const SHEET_NAME = '접수';
const APPLY_SHEET_NAME = '지원';
// 1행 머리글. 값은 열 위치가 아니라 이 이름으로 찾아 넣는다(이미 만든 시트에 열을 끼워 넣어도 안 깨지게).
// 이미 있는 시트에 빠진 머리글은 바로 앞 머리글 오른쪽에 열을 끼워 넣는다(기존 줄은 그대로 오른쪽으로 밀린다).
const HEADERS = [
  'id', '접수시각', '매장명', '위치', '전화번호', '연락동의', '업종', '지역', '운영기간', '고민상태', '고민원문', '진단답',
  '1순위유형', '1순위점수', '2순위유형', '추천전공', '기관연결필요', '출처',
];
// 학생 지원 기록. 이름·연락처는 받지 않는다.
const APPLY_HEADERS = [
  'id', '지원시각', '상태', '취소시각', '과제', '과제출처', '업종', '지역', '과제유형',
  '학년', '전공', '선호유형', '인원', '방식',
];
const MAX_TEXT_LENGTH = 200;
const MAX_STORE_LENGTH = 30;
const MAX_LOCATION_LENGTH = 30;
const RECENT_COUNT = 10;
const LOCK_WAIT_MS = 10000;
const SUMMARY_CACHE_KEY = 'summary-v3';
const SUMMARY_CACHE_SECONDS = 2;

// 화면(js/app.js, data/categories.json)에 있는 값만 받는다.
const ALLOWED = {
  industry: ['카페·디저트', '음식점', '소매', '서비스(미용·학원 등)', '기타'],
  area: ['조치원읍', '신도심', '면 지역'],
  years: ['1년 미만', '1~3년', '3년 이상'],
  concernState: ['known', 'direction', 'unknown'],
  category: ['promo', 'menu', 'ops', 'booking', 'design', 'customer', 'funding'],
  major: ['경영·사회', 'IT·이공', '디자인·예체능'],
  grade: ['1학년', '2학년', '3학년', '4학년'],
  studentCategory: ['promo', 'menu', 'ops', 'booking', 'design', 'customer'],
  taskSource: ['live', 'device', 'seed'],
  mode: ['solo', 'match', 'friends'],
  diag: [
    ['늘었다', '비슷', '줄었다'],
    ['새 손님이 안 온다', '단골이 줄었다', '일이 너무 많다', '돈 관리가 어렵다'],
    ['예', '일부', '모름'],
    ['있다', '없다', '몰랐다'],
  ],
};

// 원문·매장명·위치는 저장 전에 장난 입력과 (본문 속) 연락처를 가린다. 전화번호는 전용 칸으로만 받는다.
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
  if (body && body.action === 'apply') return json_(apply_(body.record));
  if (body && body.action === 'cancel') return json_(cancel_(body.id));
  if (body && body.action === 'reset') return json_(reset_(body.key));
  return json_({ ok: false, error: 'unknown_action' });
}

/** 편집기에서 실행한다. 권한을 승인하고 '접수'·'지원' 탭과 머리글을 만들거나, 빠진 머리글을 채운다. */
function setup() {
  getSheet_();
  getApplySheet_();
}

function getSheet_() {
  return ensureSheet_(SHEET_NAME, HEADERS);
}

function getApplySheet_() {
  return ensureSheet_(APPLY_SHEET_NAME, APPLY_HEADERS);
}

function ensureSheet_(name, headers) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(name);
  if (!sheet) sheet = book.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    return sheet;
  }
  headers.forEach((header, i) => {
    const present = headerRow_(sheet);
    if (present.indexOf(header) !== -1) return;
    const before = i === 0 ? -1 : present.indexOf(headers[i - 1]);
    if (before === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header);
      return;
    }
    sheet.insertColumnAfter(before + 1);
    sheet.getRange(1, before + 2).setValue(header);
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
    const cleared = clearRows_(getSheet_());
    clearRows_(getApplySheet_());
    CacheService.getScriptCache().remove(SUMMARY_CACHE_KEY);
    return { ok: true, cleared };
  } finally {
    lock.releaseLock();
  }
}

function clearRows_(sheet) {
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).clearContent();
  return Math.max(last - 1, 0);
}

// 학생 지원: 같은 id를 다시 보내면 한 번만 남긴다.
function apply_(raw) {
  const record = cleanApply_(raw);
  if (!record) return { ok: false, error: 'invalid_record' };
  return withLock_(() => {
    const sheet = getApplySheet_();
    const index = headerIndex_(sheet);
    if (findRow_(sheet, index, record.id)) return { ok: true, duplicate: true };
    const values = {
      id: record.id,
      지원시각: new Date().toISOString(),
      상태: '지원',
      취소시각: '',
      과제: record.taskId,
      과제출처: { live: '실제 접수', device: '이 기기 접수', seed: '예시' }[record.taskSource],
      업종: record.industry,
      지역: record.area,
      과제유형: record.category,
      학년: record.grade,
      전공: record.major,
      선호유형: record.prefs.join(', '),
      인원: record.size,
      방식: { solo: '혼자', match: '학생 찾기', friends: '친구와 함께' }[record.mode],
    };
    sheet.appendRow(rowOf_(values, index, sheet.getLastColumn(), APPLY_HEADERS.length));
    return { ok: true };
  });
}

// 학생 지원 취소: 줄을 지우지 않고 상태만 '취소'로 바꾼다.
function cancel_(id) {
  if (!ID_PATTERN.test(String(id || ''))) return { ok: false, error: 'invalid_id' };
  return withLock_(() => {
    const sheet = getApplySheet_();
    const index = headerIndex_(sheet);
    const row = findRow_(sheet, index, String(id));
    if (!row) return { ok: true, missing: true };
    sheet.getRange(row, index['상태'] + 1).setValue('취소');
    sheet.getRange(row, index['취소시각'] + 1).setValue(new Date().toISOString());
    return { ok: true };
  });
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_WAIT_MS);
  } catch (err) {
    return { ok: false, error: 'busy' };
  }
  try {
    return fn();
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
  // 집계와 알림에 필요한 칸만 꺼낸다. 고민원문·전화번호 칸은 읽지 않는다.
  const records = values.slice(1)
    .filter((row) => cell(row, 'id'))
    .map((row) => {
      const agency = cell(row, '기관연결필요');
      const category = cell(row, '1순위유형');
      return {
        id: String(cell(row, 'id')),
        ts: toIso_(cell(row, '접수시각')),
        storeName: String(cell(row, '매장명') || ''),
        location: String(cell(row, '위치') || ''),
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

// js/dashboard.js 의 summarize()와 같은 규칙으로 센다. 최근 10건에는 새 접수 알림용 id·서버가 받은 시각·매장명·위치를 넣는다.
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
      storeName: shown_(record.storeName),
      location: shown_(record.location),
      industry: record.industry,
      area: record.area,
      category: record.categories && record.categories[0] ? record.categories[0].id : null,
      concernState: record.concernState,
      needsAgency: record.needsAgency,
      source: record.source,
    }));
  return summary;
}

// 시트에 수식 막이로 붙인 ' 는 화면에 보내지 않는다.
function shown_(value) {
  return String(value || '').replace(/^'/, '');
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
  // 전화번호는 동의했을 때만 남긴다. 형식이 맞지 않으면 버린다.
  const phone = raw.contactConsent === true ? cleanPhone_(raw.phone) : '';

  return {
    id,
    storeName: cleanText_(raw.storeName, MAX_STORE_LENGTH),
    location: cleanText_(raw.location, MAX_LOCATION_LENGTH),
    phone,
    contactConsent: Boolean(phone),
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

function cleanApply_(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  const taskId = String(raw.taskId || '');
  const size = Number(raw.size);
  const taskSource = pick_(raw.taskSource, ALLOWED.taskSource);
  const mode = pick_(raw.mode, ALLOWED.mode);
  const industry = pick_(raw.industry, ALLOWED.industry);
  const area = pick_(raw.area, ALLOWED.area);
  const category = pick_(raw.category, ALLOWED.studentCategory);
  if (!ID_PATTERN.test(id) || !/^[a-z0-9-]{1,40}$/.test(taskId)) return null;
  if (!taskSource || !mode || !industry || !area || !category) return null;
  if (!(size >= 1 && size <= 5 && Math.floor(size) === size)) return null;
  if ((mode === 'solo') !== (size === 1)) return null;
  return {
    id,
    taskId,
    taskSource,
    industry,
    area,
    category,
    grade: pick_(raw.grade, ALLOWED.grade) || '',
    major: pick_(raw.major, ALLOWED.major) || '',
    prefs: (Array.isArray(raw.prefs) ? raw.prefs : [])
      .filter((item, i, list) => ALLOWED.studentCategory.indexOf(item) !== -1 && list.indexOf(item) === i),
    size,
    mode,
  };
}

// 숫자만 9~11자리, 0으로 시작해야 받는다. 시트가 숫자로 바꿔 앞의 0을 지우지 않게 ' 를 붙여 글자로 저장한다.
function cleanPhone_(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!/^0\d{8,10}$/.test(digits)) return '';
  let formatted;
  if (digits.indexOf('02') === 0) formatted = digits.replace(/^(02)(\d{3,4})(\d{4})$/, '$1-$2-$3');
  else formatted = digits.replace(/^(0\d{2})(\d{3,4})(\d{4})$/, '$1-$2-$3');
  return "'" + formatted;
}

function toRow_(record, receivedAt, index, width) {
  const [first, second] = record.categories;
  const values = {
    id: record.id,
    접수시각: receivedAt,
    매장명: record.storeName,
    위치: record.location,
    전화번호: record.phone,
    연락동의: record.contactConsent ? '동의' : '',
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
  return rowOf_(values, index, width, HEADERS.length);
}

function rowOf_(values, index, width, headerCount) {
  const row = new Array(Math.max(width, headerCount)).fill('');
  Object.keys(values).forEach((name) => {
    if (name in index) row[index[name]] = values[name];
  });
  return row;
}

function hasId_(sheet, index, id) {
  return Boolean(findRow_(sheet, index, id));
}

// id가 있는 줄 번호(1부터, 머리글 포함). 없으면 0.
function findRow_(sheet, index, id) {
  const last = sheet.getLastRow();
  if (last < 2 || !('id' in index)) return 0;
  const ids = sheet.getRange(2, index.id + 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i += 1) {
    if (String(ids[i][0]) === id) return i + 2;
  }
  return 0;
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
