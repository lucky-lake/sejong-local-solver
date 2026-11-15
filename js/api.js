// Apps Script 통신과 오프라인 대체 (SPEC 3-3, 3-4)

// README '6. 웹앱 주소를 api.js에 넣기'에서 복사한 주소(…/exec)를 따옴표 안에 붙여 넣는다.
// 비워 두면 서버 없이 오프라인 시연 모드로 동작한다.
export const API_URL = 'https://script.google.com/macros/s/AKfycbzEvr_4R0sZdJ2wz2RIQ20kPHUgeLY25fdSiz-8WXnemZY08eWYK5vT7qVb12mOY0yA/exec';

export const MAX_SUBMISSIONS_PER_DEVICE = 3;

const TIMEOUT_MS = 8000;
const RETRY_DELAYS_MS = [5000, 15000, 30000];
const LOG_KEY = 'sls.submissions.v1';
const PENDING_KEY = 'sls.pending.v1';

// 사생활 보호 모드나 인앱 브라우저에서 저장소가 막혀도 흐름은 멈추지 않게 한다.
const memory = {};

function readList(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? [];
  } catch {
    return memory[key] ?? [];
  }
}

function writeList(key, list) {
  memory[key] = list;
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // 메모리에만 남긴다.
  }
}

export function isConfigured() {
  return /^https?:\/\/\S+\/exec$/.test(API_URL);
}

export function getLocalSubmissions() {
  return readList(LOG_KEY);
}

export function clearLocalSubmissions() {
  writeList(LOG_KEY, []);
  writeList(PENDING_KEY, []);
}

// 전화번호는 서버에 보낸 뒤에는 이 기기에 남기지 않는다(대시보드 오프라인 모드는 번호를 쓰지 않는다).
function forgetPhone(id) {
  writeList(LOG_KEY, getLocalSubmissions().map((item) => (
    item.id === id && item.phone ? { ...item, phone: '' } : item
  )));
}

export function remainingSubmissions() {
  return Math.max(MAX_SUBMISSIONS_PER_DEVICE - getLocalSubmissions().length, 0);
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'server_error');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// text/plain으로 보내야 브라우저가 사전 확인(CORS preflight) 없이 Apps Script에 바로 보낸다.
function post(payload) {
  return request(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });
}

let flushing = null;
let retryIndex = 0;
let retryTimer = null;

function scheduleRetry() {
  if (retryTimer || retryIndex >= RETRY_DELAYS_MS.length) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryIndex += 1;
    flushPending();
  }, RETRY_DELAYS_MS[retryIndex]);
}

// 보내지 못한 접수를 순서대로 다시 보낸다. 서버가 id로 중복을 막는다.
export function flushPending() {
  if (!isConfigured()) return Promise.resolve(0);
  if (flushing) return flushing;

  flushing = (async () => {
    let sent = 0;
    for (const id of readList(PENDING_KEY)) {
      const record = getLocalSubmissions().find((item) => item.id === id);
      try {
        if (record) await post({ action: 'save', record });
        writeList(PENDING_KEY, readList(PENDING_KEY).filter((pendingId) => pendingId !== id));
        forgetPhone(id);
        sent += 1;
      } catch {
        scheduleRetry();
        break;
      }
    }
    return sent;
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

// 결과 mode: 'online' 발표 화면에 반영, 'offline' 이 기기에만 저장(연결되면 다시 보냄), 'limit' 기기당 횟수 초과
export async function submit(record) {
  if (remainingSubmissions() === 0) return { ok: false, mode: 'limit' };

  // 서버가 없으면 보낼 일이 없으니 번호는 처음부터 기기에 남기지 않는다.
  writeList(LOG_KEY, [...getLocalSubmissions(), isConfigured() ? record : { ...record, phone: '' }]);
  if (!isConfigured()) return { ok: true, mode: 'offline' };

  writeList(PENDING_KEY, [...readList(PENDING_KEY), record.id]);
  try {
    await post({ action: 'save', record });
    writeList(PENDING_KEY, readList(PENDING_KEY).filter((id) => id !== record.id));
    forgetPhone(record.id);
    flushPending();
    return { ok: true, mode: 'online' };
  } catch {
    scheduleRetry();
    return { ok: true, mode: 'offline' };
  }
}

// 학생 지원·취소 기록. 시연용이라 실패해도 다시 보내지 않고 화면 흐름은 그대로 간다.
export async function sendApplication(record) {
  if (!isConfigured()) return { ok: false, mode: 'offline' };
  try {
    await post({ action: 'apply', record });
    return { ok: true, mode: 'online' };
  } catch {
    return { ok: false, mode: 'offline' };
  }
}

export async function sendCancel(id) {
  if (!isConfigured()) return { ok: false, mode: 'offline' };
  try {
    await post({ action: 'cancel', id });
    return { ok: true, mode: 'online' };
  } catch {
    return { ok: false, mode: 'offline' };
  }
}

export async function fetchSummary() {
  const data = await request(`${API_URL}?action=summary&t=${Date.now()}`);
  return data.summary;
}

export async function resetLiveData(key) {
  return post({ action: 'reset', key });
}
