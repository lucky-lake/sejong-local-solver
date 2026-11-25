// 기관 대시보드: 집계 표시, 3초 폴링, 키보드 조작(R·S·F·N·P), 새 고민 알림, 관리자 초기화 (SPEC 2장, 3-3, 3-3b, 3-4)
// 화면 구성과 알림 동작은 확정 시안(design/prototype-dashboard.html)을 따른다.
// 고민 원문과 매장명은 서버 집계에 들어 있지 않고, 이 화면 어디에도 쓰지 않는다.
import {
  isConfigured,
  fetchSummary,
  resetLiveData,
  getLocalSubmissions,
  clearLocalSubmissions,
} from './api.js';
import { icon, gomi } from './art.js';

const POLL_MS = 3000;
const COUNT_ANIMATION_MS = 700;
const RECENT_COUNT = 10;
const FEED_SHOWN = 4;
const SEED_PREF_KEY = 'sls.dash.seed';
// 새 고민 알림: 말풍선은 한 번에 하나, 4초씩. 줄에 3건 이상 쌓이면 한 장으로 묶는다.
const BUBBLE_MS = 4000;
const BUBBLE_GAP_MS = 350;
const BATCH_AT = 3;
const PICK_HOT_MS = 3000;
const PANEL_MAX = 30;

const AREAS = ['조치원읍', '신도심', '면 지역'];
// 막대 순서와 지역 표의 열은 시안을 따른다. 표에 없는 유형은 '기타'로 묶는다.
const BAR_ORDER = ['promo', 'design', 'menu', 'customer', 'booking', 'ops', 'funding'];
const HEAT_COLUMNS = ['promo', 'design', 'menu', 'customer'];
const AGENCY_CATEGORY_ID = 'funding';
const INDUSTRY_SHORT = { '카페·디저트': '카페', 음식점: '음식점', 소매: '소매점', '서비스(미용·학원 등)': '서비스업', 기타: '가게' };
const INDUSTRY_ICON = {
  '카페·디저트': ['cup', '#FFE9E2', '#C9472A'],
  음식점: ['bowl', '#E6F2FF', '#1F5FA8'],
  소매: ['bag', '#EEEAFE', '#6A4DE8'],
  '서비스(미용·학원 등)': ['scissors', '#DDF4F2', '#0F7F7A'],
};
const STATE_LABEL = { known: '해결책을 알아요', direction: '방향만 있어요', unknown: '모르겠어요' };
const PANEL_TABS = [['all', '전체'], ['agency', '기관 연결'], ['unknown', '모르겠어요']];
const BELL_SVG = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>';
const CLOSE_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const RESET_ERRORS = {
  forbidden: '관리자 키가 맞지 않아요.',
  no_admin_key: '스크립트 속성에 ADMIN_KEY가 없어요.',
};

const $ = (id) => document.getElementById(id);

let categories = [];
let seedSummary = null;
let seedList = [];
let live = null;
let mode = 'offline';
let lastOkAt = null;
let previous = null;
let adminKey = null;
let pollTimer = null;
let polling = false;
let showSeed = readSeedPref();

// 알림 상태
const arrived = new Map(); // 접수 키 → { item, at } (at: 이 화면이 처음 본 시각, 처음부터 있던 접수는 0)
let alertSource = null; // 'live' | 'device' — 바뀌면 새 접수로 치지 않고 기준만 다시 잡는다.
let queue = [];
let showing = false;
let bubbleOn = true;
let hot = null;
let seenAt = Date.now();
let readAt = Date.now();
let panelTab = 'all';
let panelSig = '';

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
    .map(toRecent);
  return summary;
}

// 최근 목록에는 알림에 필요한 칸만 남긴다(원문·전화번호 없음. 매장명·위치는 알림에 띄운다).
function toRecent(record) {
  return {
    id: record.id ?? null,
    ts: record.ts,
    storeName: record.storeName ?? '',
    location: record.location ?? '',
    industry: record.industry,
    area: record.area,
    category: record.categories?.[0]?.id ?? null,
    concernState: record.concernState ?? null,
    needsAgency: Boolean(record.needsAgency),
    source: record.source,
  };
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

function heatColumn(categoryId) {
  return HEAT_COLUMNS.includes(categoryId) ? categoryId : 'etc';
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
}

// 머리글은 '·'에서 나눠 둔다. 넓은 화면은 한 줄, 휴대폰 폭에서는 두 줄('사진' / '디자인')로 보인다.
function headLabel(text) {
  return String(text).split('·').map((part) => `<span>${esc(part)}</span>`).join('<i>·</i>');
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
  const head = columns.map((column) => `<th scope="col">${headLabel(column === 'etc' ? '기타' : categoryOf(column)?.short ?? '')}</th>`).join('');
  const rows = AREAS.map((area) => {
    const cells = columns.map((column) => {
      const value = cell(area, column);
      const rgb = tint(value, max);
      return `<td><div data-c="${esc(`${area}|${column}`)}" style="background:rgb(${rgb.join(',')});color:${luminance(rgb) < 0.3 ? '#fff' : '#22252B'}">${value}</div></td>`;
    }).join('');
    return `<tr><td>${esc(area)}</td>${cells}</tr>`;
  }).join('');
  $('heat').innerHTML = `<thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody>`;
}

function recentKey(item) {
  return item.id ? `id|${item.id}` : `${item.ts}|${item.category}|${item.area}|${item.source}`;
}

function renderFeed(view) {
  const before = new Set((previous?.recent ?? []).map(recentKey));
  const items = view.recent.slice(0, FEED_SHOWN);
  $('feed').innerHTML = items.map((item) => {
    const isNew = previous && !before.has(recentKey(item));
    // 예시 데이터는 실제 접수 시각이 없으므로 시각 자리를 비워 둔다('예시' 표시는 하지 않음, 11/25 운호 결정).
    const when = item.source === 'seed' ? '' : ago(item.ts);
    const where = `${item.industry} · ${item.area}${item.source === 'device' ? ' · 이 기기' : ''}`;
    return `<li class="${isNew ? 'new' : ''}"><div>${esc(categoryOf(item.category)?.name ?? '분류 없음')}<em>${esc(where)}</em></div><span>${esc(when)}</span></li>`;
  }).join('') || '<li class="empty">아직 들어온 고민이 없어요</li>';
}

// ---------- 새 고민 알림 (SPEC 3-3b) ----------
// 서버 최근 10건(또는 이 기기 접수) 중 처음 보는 id만 새 접수로 친다. 처음 열었을 때 있던 접수는 알리지 않는다.
function detectArrivals(own) {
  const source = mode === 'offline' ? 'device' : 'live';
  const items = own.recent;
  if (source !== alertSource) {
    items.forEach((item) => {
      if (!arrived.has(recentKey(item))) arrived.set(recentKey(item), { item, at: 0 });
    });
    alertSource = source;
    return;
  }
  const fresh = items.filter((item) => !arrived.has(recentKey(item)));
  if (!fresh.length) return;
  const now = Date.now();
  fresh.forEach((item) => arrived.set(recentKey(item), { item, at: now }));
  onArrive(fresh.slice().reverse()); // 먼저 온 것부터
}

function whereText(item) {
  return `${item.area} ${INDUSTRY_SHORT[item.industry] ?? '가게'}`;
}

// 알림 제목: 가게 이름이 있으면 가게 이름, 없으면 '동네 업종'(예: 조치원읍 카페)
function titleText(item) {
  return String(item.storeName ?? '').trim() || whereText(item);
}

// 알림 보조 줄: 적어 준 위치와, 가게 이름을 제목으로 썼다면 '동네 업종'
function placeText(item) {
  const store = String(item.storeName ?? '').trim();
  return [String(item.location ?? '').trim(), store ? whereText(item) : ''].filter(Boolean).join(' · ');
}

function shortName(categoryId) {
  return categoryOf(categoryId)?.short ?? '';
}

function onArrive(items) {
  queue.push(...items);
  ringBell();
  pump();
  waitTag();
}

function pump() {
  if (showing || !queue.length) return;
  const batch = queue.length >= BATCH_AT ? queue.splice(0, queue.length) : [queue.shift()];
  showing = true;
  setHot(batch, BUBBLE_MS);
  if (bubbleOn) showBubble(batch);
  setTimeout(() => {
    hideBubble();
    setTimeout(() => {
      showing = false;
      pump();
    }, BUBBLE_GAP_MS);
  }, BUBBLE_MS);
}

function showBubble(batch) {
  const bubble = $('bub');
  if (batch.length === 1) {
    const item = batch[0];
    bubble.innerHTML = `방금 <b>${esc(titleText(item))}</b>에서 <b>${esc(shortName(item.category))}</b> 고민이 왔어요!<span class="wait" id="wait" hidden></span><small>${esc(placeText(item) || '오른쪽 아래 목록에도 쌓여요')}</small>`;
  } else {
    const counts = {};
    batch.forEach((item) => {
      counts[item.category] = (counts[item.category] ?? 0) + 1;
    });
    const sum = Object.keys(counts)
      .sort((a, b) => counts[b] - counts[a])
      .map((id) => `${shortName(id)} ${counts[id]}`)
      .join(' · ');
    bubble.innerHTML = `와, <b>방금 ${batch.length}건</b>이 한꺼번에 왔어요!<span class="wait" id="wait" hidden></span><small>${esc(sum)}</small>`;
  }
  // 넓은 화면에서는 오른쪽 위 버튼과 겹치지 않게 남은 공간만큼만 넓힌다.
  bubble.style.maxWidth = '';
  if (window.innerWidth > 640) {
    const room = document.querySelector('.live').getBoundingClientRect().left
      - document.querySelector('.head .l').getBoundingClientRect().right - 32;
    const cap = parseFloat(getComputedStyle(bubble).maxWidth) || 520;
    if (room < cap) bubble.style.maxWidth = `${Math.max(240, room)}px`;
  }
  waitTag();
  bubble.classList.add('on');
  $('mascot').innerHTML = gomi('wow', 92);
}

function hideBubble() {
  $('bub').classList.remove('on');
  $('mascot').innerHTML = gomi('happy', 92);
}

function waitTag() {
  const wait = $('wait');
  if (!wait) return;
  wait.hidden = !queue.length;
  wait.textContent = `+${queue.length} 대기`;
}

// 바뀐 칸 반짝: 지역×유형 칸과 유형 막대에 노란 링, 칸과 접수 수에 '+n'
function setHot(items, ms) {
  const next = { cells: {}, bars: {}, kpi: items.length, until: Date.now() + ms, fresh: true };
  items.forEach((item) => {
    const key = `${item.area}|${heatColumn(item.category)}`;
    next.cells[key] = (next.cells[key] ?? 0) + 1;
    next.bars[item.category] = true;
  });
  hot = next;
  paintHot();
  setTimeout(paintHot, ms + 60);
}

function paintHot() {
  const current = hot && hot.until > Date.now() ? hot : null;
  document.querySelectorAll('#heat td div[data-c]').forEach((element) => {
    const count = current?.cells[element.dataset.c];
    element.querySelector('.plus')?.remove();
    element.classList.toggle('hot', Boolean(count));
    if (count) element.insertAdjacentHTML('beforeend', `<span class="plus${current.fresh ? ' pop' : ''}">+${count}</span>`);
  });
  document.querySelectorAll('#bars .br[data-id]').forEach((element) => {
    element.classList.toggle('hot', Boolean(current?.bars[element.dataset.id]));
  });
  const plus = $('k-plus');
  plus.hidden = !current?.kpi;
  if (current?.kpi) {
    plus.textContent = `+${current.kpi}`;
    if (current.fresh) {
      plus.classList.remove('pop');
      void plus.offsetWidth;
      plus.classList.add('pop');
    }
  }
  if (current) current.fresh = false;
}

// 종 알림함
function ringBell() {
  const bell = $('bell');
  // 'ring'은 결과 화면 점수 원(.ring) 클래스와 겹쳐 종이 눕는다. 다른 이름을 쓴다.
  bell.classList.remove('ringing');
  void bell.offsetWidth;
  bell.classList.add('ringing');
}

function unseenCount() {
  let count = 0;
  arrived.forEach(({ at }) => {
    if (at > seenAt) count += 1;
  });
  return count;
}

function paintBell() {
  const count = unseenCount();
  $('nb').hidden = !count;
  $('nb').textContent = count > 9 ? '9+' : String(count);
  $('bell').setAttribute('aria-label', `새 고민 알림${count ? `, 안 읽음 ${count}건` : ''}`);
  if (!$('npanel').hidden) paintPanel();
}

// 알림함 목록: 실제 접수(처음 본 순서) + 예시 데이터(켜져 있을 때)
function panelItems() {
  const own = [...arrived.values()]
    .sort((a, b) => b.at - a.at || byNewest(a.item, b.item))
    .map(({ item, at }) => ({ item, unread: at > readAt }));
  const seeds = showSeed ? seedList.map((item) => ({ item, unread: false })) : [];
  return [...own, ...seeds];
}

function paintPanel(force = false) {
  const all = panelItems();
  const sig = [arrived.size, showSeed, panelTab, readAt, all.filter((entry) => entry.unread).length].join('|');
  // 3초마다 다시 그려도, 데이터가 바뀔 때만 알림함을 다시 그린다(누르던 버튼이 사라지지 않게).
  if (!force && sig === panelSig) return;
  panelSig = sig;
  const groups = {
    all,
    agency: all.filter(({ item }) => item.needsAgency),
    unknown: all.filter(({ item }) => item.concernState === 'unknown'),
  };
  $('ntabs').innerHTML = PANEL_TABS.map(([id, label]) =>
    `<button type="button" data-t="${id}" aria-pressed="${panelTab === id}">${label} ${groups[id].length}</button>`
  ).join('');
  const list = groups[panelTab].slice(0, PANEL_MAX);
  $('nlist').innerHTML = list.length
    ? list.map(({ item, unread }, i) => {
      const [name, bg, fg] = INDUSTRY_ICON[item.industry] ?? ['store', '#F5F7FA', '#22252B'];
      const tags = [placeText(item), item.needsAgency ? '기관 연결 필요' : '', STATE_LABEL[item.concernState] ?? ''].filter(Boolean).join(' · ');
      const when = item.source === 'seed' ? '' : ago(item.ts);
      return `<li><button type="button" class="nit${unread ? ' unread' : ''}" data-i="${i}">`
        + `<span class="nico" style="background:${bg};color:${fg}">${icon(name, 22)}</span>`
        + `<span><p>${esc(titleText(item))}에서<br>${esc(shortName(item.category))} 고민이 왔어요</p><em>${esc(tags)}</em></span>`
        + `<span class="tm">${esc(when)}</span>${unread ? '<span class="ndot" aria-label="안 읽음"></span>' : ''}</button></li>`;
    }).join('')
    : `<li class="nempty">${gomi('think', 48)}<span>아직 이 분류의 고민이 없어요</span></li>`;
  $('ntabs').querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      panelTab = button.dataset.t;
      paintPanel(true);
      $('ntabs').querySelector('[aria-pressed="true"]')?.focus();
    });
  });
  $('nlist').querySelectorAll('.nit').forEach((button) => {
    button.addEventListener('click', () => {
      const { item } = list[Number(button.dataset.i)];
      closePanel();
      setHot([item], PICK_HOT_MS);
    });
  });
}

function openPanel() {
  $('npanel').hidden = false;
  $('bell').setAttribute('aria-expanded', 'true');
  seenAt = Date.now();
  paintBell();
  paintPanel(true);
  $('npanel').querySelector('.ntabs button')?.focus();
}

function closePanel(refocus = false) {
  if ($('npanel').hidden) return;
  $('npanel').hidden = true;
  $('bell').setAttribute('aria-expanded', 'false');
  readAt = seenAt;
  if (refocus) $('bell').focus();
}

function togglePanel() {
  if ($('npanel').hidden) openPanel();
  else closePanel(true);
}

function toggleBubble() {
  bubbleOn = !bubbleOn;
  if (!bubbleOn) hideBubble();
  $('p-key').textContent = bubbleOn ? 'P 말풍선 끄기' : 'P 말풍선 켜기 (지금 꺼짐)';
}

function setupAlerts() {
  $('bell-ic').innerHTML = BELL_SVG;
  $('n-close').innerHTML = CLOSE_SVG;
  $('bell').addEventListener('click', (event) => {
    event.stopPropagation();
    togglePanel();
  });
  $('n-close').addEventListener('click', () => closePanel(true));
  $('n-all').addEventListener('click', () => {
    readAt = Date.now();
    seenAt = readAt;
    paintBell();
    paintPanel(true);
  });
  $('npanel').addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', () => closePanel());
}

// ---------- 그리기 ----------
function draw() {
  const own = ownSummary();
  const view = mergeSummaries(showSeed && seedSummary ? [own, seedSummary] : [own]);
  const animate = previous !== null;
  renderStatus();
  renderKpis(view, animate);
  renderBars(view);
  renderHeat(view);
  renderFeed(view);
  detectArrivals(own);
  paintHot();
  paintBell();
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
  if (event.target?.closest?.('input, textarea')) return;
  if (event.key === 'Escape') {
    closePanel(true);
    return;
  }
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
  } else if (event.code === 'KeyN') {
    togglePanel();
  } else if (event.code === 'KeyP') {
    toggleBubble();
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
    ? '실시간 시연 데이터를 모두 지울까요? 설문 데이터는 그대로 남아요.'
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
  setupAlerts();

  try {
    const [categoryData, seed] = await Promise.all([loadJson('data/categories.json'), loadJson('data/seed.json')]);
    categories = categoryData.categories;
    const seedRecords = seed.items.map((item) => ({ ...item, source: 'seed' }));
    seedSummary = summarize(seedRecords);
    seedList = seedRecords.slice().sort(byNewest).map(toRecent);
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
