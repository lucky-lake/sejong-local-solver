// 기관 대시보드: 집계 표시, 3초 폴링, 키보드 조작(R·S·F), 관리자 초기화 (SPEC 2장, 3-3, 3-4)
// 화면 구성은 확정 시안(design/prototype-dashboard.html)을 따른다.
import {
  isConfigured,
  fetchSummary,
  resetLiveData,
  getLocalSubmissions,
  clearLocalSubmissions,
} from './api.js';
import { icon, gomi } from './art.js';

const POLL_MS = 3000;
const FLASH_MS = 1400;
const COUNT_ANIMATION_MS = 700;
const RECENT_COUNT = 10;
const FEED_SHOWN = 4;
const SEED_PREF_KEY = 'sls.dash.seed';

const AREAS = ['조치원읍', '신도심', '면 지역'];
// 막대 순서와 지역 표의 열은 시안을 따른다. 표에 없는 유형은 '기타'로 묶는다.
const BAR_ORDER = ['promo', 'design', 'menu', 'customer', 'booking', 'ops', 'funding'];
const HEAT_COLUMNS = ['promo', 'design', 'menu', 'customer'];
const AGENCY_CATEGORY_ID = 'funding';
const RESET_ERRORS = {
  forbidden: '관리자 키가 맞지 않아요.',
  no_admin_key: '스크립트 속성에 ADMIN_KEY가 없어요.',
};

const $ = (id) => document.getElementById(id);

let categories = [];
let seedSummary = null;
let live = null;
let mode = 'offline';
let lastOkAt = null;
let previous = null;
let adminKey = null;
let pollTimer = null;
let polling = false;
let showSeed = readSeedPref();

// apps-script/Code.gs 의 summarize_()와 같은 규칙으로 센다. 1위 유형 하나로만 센다.
export function summarize(records) {
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
    const category = record.categories?.[0]?.id ?? null;
    summary.total += 1;
    if (record.needsAgency) summary.needsAgency += 1;
    add(summary.byCategory, category);
    add(summary.byArea, record.area);
    add(summary.byIndustry, record.industry);
    add(summary.byState, record.concernState);
    if (record.area && category) {
      summary.areaCategory[record.area] ??= {};
      add(summary.areaCategory[record.area], category);
    }
  });
  summary.recent = records
    .slice()
    .sort(byNewest)
    .slice(0, RECENT_COUNT)
    .map((record) => ({
      ts: record.ts,
      industry: record.industry,
      area: record.area,
      category: record.categories?.[0]?.id ?? null,
      source: record.source,
    }));
  return summary;
}

export function mergeSummaries(list) {
  const merged = summarize([]);
  for (const summary of list) {
    merged.total += summary.total;
    merged.needsAgency += summary.needsAgency;
    for (const key of ['byCategory', 'byArea', 'byIndustry', 'byState']) addCounts(merged[key], summary[key]);
    for (const [area, counts] of Object.entries(summary.areaCategory)) {
      merged.areaCategory[area] ??= {};
      addCounts(merged.areaCategory[area], counts);
    }
    merged.recent.push(...summary.recent);
  }
  merged.recent = merged.recent.sort(byNewest).slice(0, RECENT_COUNT);
  return merged;
}

function add(bucket, key) {
  if (key) bucket[key] = (bucket[key] ?? 0) + 1;
}

function addCounts(target, source = {}) {
  for (const [key, count] of Object.entries(source)) target[key] = (target[key] ?? 0) + count;
}

function byNewest(a, b) {
  return (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function readSeedPref() {
  try {
    return localStorage.getItem(SEED_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeSeedPref(on) {
  try {
    localStorage.setItem(SEED_PREF_KEY, on ? 'on' : 'off');
  } catch {
    // 저장이 막혀도 이번 화면에서는 동작한다.
  }
}

function clock(date) {
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function ago(ts) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 60000));
  if (Number.isNaN(minutes)) return '';
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  return `${Math.floor(minutes / 60)}시간 전`;
}

function categoryOf(id) {
  return categories.find((category) => category.id === id);
}

// 옅은 민트에서 진한 청록으로. 진한 칸은 흰 글자로 바꿔 대비를 지킨다.
function tint(value, max) {
  const t = max ? value / max : 0;
  const from = [240, 250, 249];
  const to = [15, 127, 122];
  return from.map((x, i) => Math.round(x + (to[i] - x) * t));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// 서버에 연결되면 서버 집계, 아니면 이 브라우저에서 올린 접수(리허설용)를 쓴다.
function ownSummary() {
  if (mode !== 'offline') return live ?? summarize([]);
  return summarize(getLocalSubmissions().map((record) => ({ ...record, source: 'device' })));
}

function flash(element) {
  if (!element) return;
  element.classList.remove('flash');
  void element.offsetWidth;
  element.classList.add('flash');
  setTimeout(() => element.classList.remove('flash'), FLASH_MS);
}

// 처음 그릴 때는 숫자를 바로 보이고, 새 접수로 바뀔 때만 올라가는 애니메이션을 쓴다.
function animateCount(element, to, animate) {
  const from = Number(element.dataset.value ?? 0);
  element.dataset.value = String(to);
  if (from === to || !animate) {
    element.textContent = String(to);
    return;
  }
  const started = performance.now();
  const step = (now) => {
    const progress = Math.min((now - started) / COUNT_ANIMATION_MS, 1);
    element.textContent = String(Math.round(from + (to - from) * (1 - (1 - progress) ** 3)));
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // 탭이 가려져 애니메이션이 멈춰도 최종 숫자는 반드시 보이게 한다.
  setTimeout(() => {
    if (element.dataset.value === String(to)) element.textContent = String(to);
  }, COUNT_ANIMATION_MS + 50);
}

function renderStatus() {
  const pill = $('mode');
  pill.className = `pill ${mode}`;
  if (mode === 'live') $('mode-text').textContent = '실시간';
  else if (mode === 'stale') $('mode-text').textContent = `연결 끊김 · ${clock(lastOkAt)} 기준`;
  else $('mode-text').textContent = isConfigured() ? '서버 연결 안 됨 · 오프라인 시연' : '오프라인 시연';
  $('seed-tag').textContent = showSeed ? '예시 데이터 포함' : '실제 접수만';
}

function renderKpis(view, animate) {
  const unknown = view.total ? Math.round(((view.byState.unknown ?? 0) / view.total) * 100) : 0;
  animateCount($('k-total'), view.total, animate);
  animateCount($('k-agency'), view.needsAgency, animate);
  animateCount($('k-unknown'), unknown, animate);
  $('policy-count').textContent = `기관 연결이 필요한 고민 ${view.needsAgency}건`;
}

function renderBars(view) {
  const count = (id) => view.byCategory[id] ?? 0;
  const max = Math.max(1, ...BAR_ORDER.map(count));
  $('bars').innerHTML = BAR_ORDER.map((id) => {
    const width = Math.round((count(id) / max) * 100);
    const cls = [id === AGENCY_CATEGORY_ID ? 'gov' : '', width ? '' : 'z'].join(' ').trim();
    return `<div class="br" data-id="${id}"><span>${esc(categoryOf(id)?.name)}</span><div class="t"><i class="${cls}" style="width:${width}%"></i></div><b>${count(id)}</b></div>`;
  }).join('');
  if (!previous) return;
  BAR_ORDER.forEach((id) => {
    if (count(id) > (previous.byCategory[id] ?? 0)) flash($('bars').querySelector(`[data-id="${id}"]`));
  });
}

function renderHeat(view) {
  const cell = (area, column) => {
    const counts = view.areaCategory[area] ?? {};
    if (column !== 'etc') return counts[column] ?? 0;
    return Object.entries(counts)
      .filter(([id]) => !HEAT_COLUMNS.includes(id))
      .reduce((sum, [, n]) => sum + n, 0);
  };
  const columns = [...HEAT_COLUMNS, 'etc'];
  const max = Math.max(1, ...AREAS.flatMap((area) => columns.map((column) => cell(area, column))));
  const head = columns.map((column) => `<th scope="col">${esc(column === 'etc' ? '기타' : categoryOf(column)?.short)}</th>`).join('');
  const rows = AREAS.map((area) => {
    const cells = columns.map((column) => {
      const value = cell(area, column);
      const rgb = tint(value, max);
      return `<td><div style="background:rgb(${rgb.join(',')});color:${luminance(rgb) < 0.3 ? '#fff' : '#22252B'}">${value}</div></td>`;
    }).join('');
    return `<tr><td>${esc(area)}</td>${cells}</tr>`;
  }).join('');
  $('heat').innerHTML = `<thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody>`;
}

function recentKey(item) {
  return `${item.ts}|${item.category}|${item.area}|${item.source}`;
}

function renderFeed(view) {
  const before = new Set((previous?.recent ?? []).map(recentKey));
  const items = view.recent.slice(0, FEED_SHOWN);
  $('feed').innerHTML = items.map((item) => {
    const isNew = previous && !before.has(recentKey(item));
    // 예시 데이터의 시각은 실제 접수 시각이 아니므로 시각 자리에 '예시'를 쓴다.
    const when = item.source === 'seed' ? '예시' : ago(item.ts);
    const where = `${item.industry} · ${item.area}${item.source === 'device' ? ' · 이 기기' : ''}`;
    return `<li class="${isNew ? 'new' : ''}"><div>${esc(categoryOf(item.category)?.name ?? '분류 없음')}<em>${esc(where)}</em></div><span>${esc(when)}</span></li>`;
  }).join('') || '<li class="empty">아직 들어온 고민이 없어요</li>';
}

function draw() {
  const own = ownSummary();
  const view = mergeSummaries(showSeed && seedSummary ? [own, seedSummary] : [own]);
  const animate = previous !== null;
  renderStatus();
  renderKpis(view, animate);
  renderBars(view);
  renderHeat(view);
  renderFeed(view);
  previous = view;
}

async function tick() {
  if (polling) return;
  polling = true;
  clearTimeout(pollTimer);
  try {
    if (isConfigured()) {
      try {
        live = await fetchSummary();
        mode = 'live';
        lastOkAt = new Date();
      } catch {
        // 한 번이라도 받았으면 마지막 집계를 유지하고 '연결 끊김'만 알린다.
        mode = live ? 'stale' : 'offline';
      }
    } else {
      mode = 'offline';
    }
    draw();
  } finally {
    polling = false;
    pollTimer = setTimeout(tick, POLL_MS);
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

// 한글 자판 상태에서도 동작하도록 글자가 아닌 키 위치(code)로 판단한다.
function onKey(event) {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code === 'KeyR') {
    tick();
  } else if (event.code === 'KeyS') {
    showSeed = !showSeed;
    writeSeedPref(showSeed);
    previous = null;
    draw();
  } else if (event.code === 'KeyF') {
    toggleFullscreen();
  }
}

// ?admin=키 로 열었을 때만 초기화 버튼을 보인다. 키는 주소창에서 바로 지운다.
function setupAdmin() {
  const params = new URLSearchParams(location.search);
  if (!params.has('admin')) return;
  adminKey = params.get('admin');
  params.delete('admin');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);

  $('admin').hidden = false;
  $('reset').textContent = isConfigured() ? '시연 데이터 비우기' : '이 기기 시연 데이터 비우기';
  $('reset').addEventListener('click', resetData);
}

async function resetData() {
  const message = $('admin-msg');
  const question = isConfigured()
    ? '실시간 시연 데이터를 모두 지울까요? 예시 데이터는 그대로 남아요.'
    : '이 기기에 저장된 시연 접수를 지울까요?';
  if (!window.confirm(question)) return;

  if (!isConfigured()) {
    clearLocalSubmissions();
    message.textContent = '이 기기의 시연 접수를 지웠어요.';
    draw();
    return;
  }
  message.textContent = '비우는 중이에요.';
  try {
    const result = await resetLiveData(adminKey);
    live = null;
    previous = null;
    message.textContent = `${result.cleared}건을 지웠어요.`;
    tick();
  } catch (error) {
    message.textContent = RESET_ERRORS[error.message] ?? '비우지 못했어요. 연결을 확인해 주세요.';
  }
}

async function loadJson(path, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
}

async function start() {
  $('mascot').innerHTML = gomi('happy', 92);
  $('qr-gomi').innerHTML = gomi('wow', 96);
  $('i1').innerHTML = icon('store', 18);
  $('i2').innerHTML = icon('hall', 18);
  $('i3').innerHTML = icon('question', 18);

  try {
    const [categoryData, seed] = await Promise.all([loadJson('data/categories.json'), loadJson('data/seed.json')]);
    categories = categoryData.categories;
    seedSummary = summarize(seed.items.map((item) => ({ ...item, source: 'seed' })));
  } catch {
    $('mode-text').textContent = '화면 데이터를 불러오지 못했어요. 새로고침해 주세요.';
    return;
  }

  setupAdmin();
  document.addEventListener('keydown', onKey);
  // 같은 브라우저의 다른 탭에서 체험을 제출하면(오프라인 리허설) 바로 반영한다.
  window.addEventListener('storage', () => {
    if (mode === 'offline') draw();
  });
  tick();
}

start();
