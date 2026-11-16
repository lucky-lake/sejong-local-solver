// 1분 체험: 라우팅, 화면 렌더링, 진행 상태.
// 화면 구성·문구·상호작용은 확정 시안(design/prototype-index.html)을 따르고,
// 분류는 classifier.js, 제출은 api.js(서버 연결 + 오프라인 대체)를 쓴다.
import {
  analyze, buildSubmission, matchTeam, normalizePhone, ringScore, teamRange,
  MAX_TEXT_LENGTH, MAX_STORE_LENGTH, MAX_LOCATION_LENGTH,
} from './classifier.js';
import {
  submit,
  sendApplication,
  sendCancel,
  flushPending,
  fetchSummary,
  getLocalSubmissions,
  isConfigured,
  remainingSubmissions,
  MAX_SUBMISSIONS_PER_DEVICE,
} from './api.js';
import { icon, gomi } from './art.js';

const INDUSTRIES = [
  { value: '카페·디저트', icon: 'cup', bg: '#FFE9E2' },
  { value: '음식점', icon: 'bowl', bg: '#FFF4CC' },
  { value: '소매', icon: 'bag', bg: '#EEEAFE' },
  { value: '서비스(미용·학원 등)', label: '서비스', hint: '미용·학원 등', icon: 'scissors', bg: '#E6F2FF' },
  { value: '기타', icon: 'dots', bg: '#F5F7FA', wide: true },
];
const AREAS = [
  { value: '조치원읍', icon: 'train', bg: '#FFF4CC', hint: '조치원역·대학가 원도심' },
  { value: '신도심', icon: 'city', bg: '#E6F2FF', hint: '나성·도담·어진동 등' },
  { value: '면 지역', icon: 'tree', bg: '#DDF4F2', hint: '연서·장군·연동면 등' },
];
const CONCERN_STATES = [
  { value: 'known', label: '해결책을 알아요', hint: '하고 싶은 일이 정해져 있어요', icon: 'bulb', bg: '#FFF4CC' },
  { value: 'direction', label: '방향만 있어요', hint: '대충 어떤 문제인지는 알아요', icon: 'compass', bg: '#E6F2FF' },
  { value: 'unknown', label: '뭐가 필요한지 모르겠어요', hint: '질문 하나로 같이 찾아봐요', icon: 'question', bg: '#EEEAFE' },
];
// '모르겠어요'를 고르면 자유 입력 대신 이 질문 하나에 답한다. answer는 진단 질문 pain의 선택지와 같다.
const SYMPTOMS = [
  { value: '새 손님이 안 와요', answer: '새 손님이 안 온다', icon: 'store', bg: '#FFE9E2' },
  { value: '단골이 줄었어요', answer: '단골이 줄었다', icon: 'people', bg: '#EEEAFE' },
  { value: '일이 너무 많아요', answer: '일이 너무 많다', icon: 'clock', bg: '#FFF4CC' },
  { value: '돈 관리가 어려워요', answer: '돈 관리가 어렵다', icon: 'won', bg: '#DDF4F2' },
];
const PAIN_QUESTION_INDEX = 1;
const EXAMPLES = [
  '인스타 홍보를 하고 싶은데 사진이 별로예요',
  '가격을 올려야 할지 모르겠어요',
  '예약 전화가 너무 많아서 일이 밀려요',
  '임대료와 세금 때문에 버거워요',
];
const MAJOR_BADGE = { '경영·사회': ['#C9472A', '경'], '디자인·예체능': ['#6A4DE8', '디'], 'IT·이공': ['#0F7F7A', 'IT'] };
const STEPS = ['industry', 'area', 'shop', 'state', 'concern'];
const ROUTES = [...STEPS, 'result', 'done'];
const AUTO_NEXT_MS = 220;
const PHASE_MS = 360;
const STATE_KEY = 'sls.flow.v2';
const MAJORS = ['경영·사회', 'IT·이공', '디자인·예체능'];
const LIVE_TASKS_SHOWN = 10;
const BOARD_MAX = 18;
const BOARD_REFRESH_MS = 10000;
const SEAT_MS = 450;

const app = document.getElementById('app');
const dock = document.getElementById('dock');
let config = null;
let agencies = [];
let timers = [];
let submitting = null;
let prevRoute = null;
let backTo = null;
let lastProgIdx = null;
let state = loadState();
let seedItems = null;
let liveRecent = null;
let liveFailed = false;
let profile; // 학생 보드: undefined(아직 안 읽음) · null(안 고름) · { grade, major, prefs, skip }
let cancelArmed = null;
let boardGen = 0;
const appliedTasks = new Map();

function emptyState() {
  return {
    industry: null,
    area: null,
    concernState: null,
    symptom: null,
    text: '',
    store: '',
    location: '',
    phone: '',
    consent: false,
    analysisShownFor: null,
    submittedId: null,
    submitStatus: null,
  };
}

function loadState() {
  try {
    return { ...emptyState(), ...JSON.parse(sessionStorage.getItem(STATE_KEY)) };
  } catch {
    return emptyState();
  }
}

function saveState() {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // 저장소가 막힌 브라우저에서는 메모리 상태로만 진행한다.
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// 괄호 묶음은 줄이 바뀌어도 중간에서 끊기지 않고 한 덩어리로 넘어가게 한다.
function keepParens(text) {
  return esc(text).replace(/\([^)]*\)/g, (part) => `<span class="nw">${part}</span>`);
}

function later(fn, ms) {
  timers.push(setTimeout(fn, ms));
}

function clearTimers() {
  timers.forEach(clearTimeout);
  timers = [];
}

// ---------- 상태 ----------
function isUnknown() {
  return state.concernState === 'unknown';
}

function stepDone(step) {
  if (step === 'industry') return Boolean(state.industry);
  if (step === 'area') return Boolean(state.area);
  if (step === 'shop') return !contactProblem();
  if (step === 'state') return Boolean(state.concernState);
  return isUnknown() ? Boolean(state.symptom) : state.text.trim().length > 0;
}

// 답을 바꾸면 그 답으로는 아직 제출하지 않은 것이 된다.
function answerChanged() {
  state.submittedId = null;
  state.submitStatus = null;
}

function stateLabel() {
  return CONCERN_STATES.find((item) => item.value === state.concernState)?.label;
}

function currentInput() {
  const unknown = isUnknown();
  const diag = [null, null, null, null];
  if (unknown) diag[PAIN_QUESTION_INDEX] = SYMPTOMS.find((item) => item.value === state.symptom)?.answer ?? null;
  return {
    industry: state.industry,
    area: state.area,
    dong: '',
    years: null,
    concernState: state.concernState,
    text: unknown ? '' : state.text.trim(),
    diag,
  };
}

function currentKey() {
  return JSON.stringify(currentInput());
}

function categoryName(id) {
  return config.categories.find((category) => category.id === id)?.name ?? '';
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- 라우팅 ----------
function routeOf(hash) {
  const path = hash.replace(/^#/, '') || '/';
  const match = path.match(/^\/try\/([a-z]+)$/);
  if (match && ROUTES.includes(match[1])) return match[1];
  if (path === '/board') return 'board';
  return path === '/about' ? 'about' : 'landing';
}

function hashOf(route) {
  if (route === 'landing') return '#/';
  if (route === 'about') return '#/about';
  if (route === 'board') return '#/board';
  return `#/try/${route}`;
}

function go(route) {
  location.hash = hashOf(route);
}

// 앞 단계를 건너뛰고 들어오면 아직 답하지 않은 첫 단계로 보낸다.
function allowedRoute(route) {
  if (!ROUTES.includes(route)) return route;
  const open = STEPS.find((step) => !stepDone(step));
  const limit = open ?? (state.submittedId ? 'done' : 'result');
  return ROUTES.indexOf(route) > ROUTES.indexOf(limit) ? limit : route;
}

// 덮개 화면(완료·운영 방식)을 닫을 때, 바로 앞 화면에서 왔으면 뒤로 가기로 돌아가 기록이 쌓이지 않게 한다.
function closeTo(route) {
  if (backTo === route) history.back();
  else location.replace(hashOf(route));
}

// ---------- 공통 조각 ----------
function tile(key, option) {
  const label = option.label ?? option.value;
  const on = state[key] === option.value;
  return `<button type="button" class="tile${option.wide ? ' wide' : ''}${on ? ' on' : ''}" data-k="${key}" data-v="${esc(option.value)}" aria-pressed="${on}">`
    + `<span class="ib" style="background:${option.bg}">${icon(option.icon, 26)}</span>`
    + `<span><b>${esc(label)}</b>${option.hint ? `<small>${esc(option.hint)}</small>` : ''}</span>`
    + `<span class="ok">${icon('check', 16)}</span></button>`;
}

function progress(idx, fromIdx) {
  const pct = (i) => (i / (STEPS.length - 1)) * 100;
  const start = pct(fromIdx ?? idx);
  return `<div class="prog" role="progressbar" aria-label="진행 단계" aria-valuemin="1" aria-valuemax="${STEPS.length}" aria-valuenow="${idx + 1}">`
    + `<div class="track"></div><div class="fill" style="width:${start}%" data-to="${pct(idx)}"></div>`
    + `<div class="me" style="left:${start}%" data-to="${pct(idx)}">${gomi('happy', 34)}</div>`
    + `<span class="lab">${idx + 1} / ${STEPS.length}</span></div>`;
}

function trail(idx) {
  const items = [['industry', state.industry], ['area', state.area], ['shop', state.store.trim() || '가게 정보'], ['state', stateLabel()]]
    .slice(0, idx)
    .filter(([, label]) => label);
  if (!items.length) return '';
  return `<div class="trail">${items.map(([step, label]) =>
    `<button type="button" data-go="${step}" aria-label="${esc(label)} 다시 고르기">${esc(label)}${icon('edit', 14)}</button>`
  ).join('')}</div>`;
}

function showDock(html) {
  dock.innerHTML = html;
  dock.hidden = false;
}

function removeOverlay() {
  document.querySelectorAll('.done, .modal').forEach((element) => element.remove());
}

function overlay(className, role, label) {
  removeOverlay();
  const element = document.createElement('div');
  element.className = className;
  element.setAttribute('role', role);
  if (label) element.setAttribute('aria-label', label);
  document.body.appendChild(element);
  return element;
}

// ---------- 랜딩 ----------
function renderLanding() {
  app.innerHTML = `
    <div class="hero">
      <span class="spk" style="right:16px;top:12px">${icon('spark', 22)}</span>
      <span class="spk" style="right:48px;top:40px;color:#fff">${icon('spark', 14)}</span>
      <span class="hero-gomi">${gomi('happy', 86)}</span><span class="bubble">고민 있으면 말해요!</span>
      <div class="tri">
        <svg class="link" viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden="true"><path d="M0 10 H200" stroke="#22252B" stroke-width="2.5" stroke-dasharray="6 6"/></svg>
        <div class="node"><span class="b" style="background:#FFE9E2;color:#C9472A">${icon('store', 30)}</span><b>청년 사업가</b><span>고민을 올려요</span></div>
        <div class="node"><span class="b" style="background:#EEEAFE;color:#6A4DE8">${icon('people', 30)}</span><b>학생 팀</b><span>찾아가 해결해요</span></div>
        <div class="node"><span class="b" style="background:#FFFFFF;color:#0F7F7A">${icon('hall', 30)}</span><b>공공기관</b><span>지원을 이어요</span></div>
      </div>
    </div>
    <h1 class="big disp" tabindex="-1">가게 고민,<br><span class="hl">학생 팀</span>이 해결해요</h1>
    <p class="lede">세종의 청년 사업가가 고민을 올리면 <span class="nw">인근 대학 학생 2~4명이</span> 가게를 찾아가 진단하고 해결해요.<br>학생은 우리 동네에서 첫 실무 경력을 쌓아요.</p>
    <a class="btn" href="${hashOf('industry')}">사장님이 되어 1분 체험 ${icon('right', 22)}</a>
    <p class="fine">이름은 받지 않아요. 전화번호는 연락에만 쓰고 발표 후 지워요</p>
    <div class="more">
      <a class="wide" href="${hashOf('board')}">${icon('people', 18)}학생 과제 보드 보기</a>
      <a href="dashboard.html">${icon('hall', 18)}발표 화면 보기</a>
      <a href="${hashOf('about')}">${icon('question', 18)}어떻게 운영돼요?</a>
    </div>`;
}

// 운영 방식: 화면 전체를 덮지 않고 글 영역만 카드로 스르륵 띄운다. 바깥(어두운 곳)을 눌러도 닫힌다.
const MODAL_CLOSE_MS = 220;

function showAbout() {
  const element = overlay('modal', 'dialog', '운영 방식');
  element.setAttribute('aria-modal', 'true');
  element.innerHTML = `<div class="modal-card">
      ${gomi('happy', 72)}
      <h2 class="disp" tabindex="-1">이렇게 운영돼요</h2>
      <ol>
        <li>사장님이 고민을 올려요</li>
        <li>학생 팀이 과제를 골라 지원해요</li>
        <li>가게를 찾아가 진단하고 결과물을 적용해요</li>
        <li>자금·세무는 공공기관으로 연결해요</li>
        <li>학생은 활동 인증과 포트폴리오를 받아요</li>
      </ol>
      <button type="button" class="btn" id="close-about">닫기</button>
    </div>`;
  element.querySelector('#close-about').addEventListener('click', closeAbout);
  element.addEventListener('click', (event) => {
    if (event.target === element) closeAbout();
  });
}

// 카드가 스르륵 내려가며 사라진 뒤 처음 화면 주소로 돌아간다.
function closeAbout() {
  const element = document.querySelector('.modal');
  if (!element) {
    closeTo('landing');
    return;
  }
  if (element.classList.contains('closing')) return;
  element.classList.add('closing');
  setTimeout(() => closeTo('landing'), MODAL_CLOSE_MS);
}

// ---------- 질문 5개 ----------
function renderStep(step) {
  const idx = STEPS.indexOf(step);
  let html = progress(idx, lastProgIdx) + trail(idx);

  if (step === 'industry') {
    html += `<h1 class="q disp" tabindex="-1">어떤 가게를 운영하세요?</h1><div class="grid">${INDUSTRIES.map((item) => tile('industry', item)).join('')}</div>`;
  } else if (step === 'area') {
    html += `<h1 class="q disp" tabindex="-1">가게는 어디에 있어요?</h1><div class="list">${AREAS.map((item) => tile('area', item)).join('')}</div>`;
  } else if (step === 'shop') {
    html += `<h1 class="q disp" tabindex="-1">가게 정보를 알려 주세요</h1>
      <p class="exh label">학생 팀과 담당자가 가게를 찾아갈 때 써요</p>
      ${shopCards()}`;
    showDock(`<button type="button" class="btn" id="shop-next">다음 ${icon('right', 22)}</button>`);
  } else if (step === 'state') {
    html += `<h1 class="q disp" tabindex="-1">고민은 얼마나 정리됐어요?</h1><div class="list">${CONCERN_STATES.map((item) => tile('concernState', item)).join('')}</div>`;
  } else if (isUnknown()) {
    html += `<h1 class="q disp" tabindex="-1">요즘 가장 아쉬운 건요?</h1><div class="grid">${SYMPTOMS.map((item) => tile('symptom', item)).join('')}</div>`;
  } else {
    html += `<div class="ask">${gomi('worry', 92)}<h1 class="bubble" tabindex="-1">어떤 고민이 있으세요?</h1></div>
      <label for="txt" class="exh label">한두 문장으로 적어 주세요 (연락처는 빼고)</label>
      <textarea id="txt" maxlength="${MAX_TEXT_LENGTH}" placeholder="예: 손님이 줄었는데 이유를 모르겠어요">${esc(state.text)}</textarea>
      <p class="err" id="err" role="alert" hidden>고민을 적거나 아래 예시를 골라 주세요</p>
      <p class="exh">다른 사장님들은 이렇게 말해요</p>
      <div class="chips">${EXAMPLES.map((text, i) => `<button type="button" class="chip" data-ex="${i}">${esc(text)}</button>`).join('')}</div>`;
    showDock(`<button type="button" class="btn coral" id="go">고민 보내고 분석받기 ${icon('right', 22)}</button>`);
  }

  app.innerHTML = html;
  lastProgIdx = idx;
  // 고미가 앞 단계 자리에서 이번 단계 자리로 걸어가게 한다.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    app.querySelectorAll('.prog [data-to]').forEach((element) => {
      if (element.classList.contains('me')) element.style.left = `${element.dataset.to}%`;
      else element.style.width = `${element.dataset.to}%`;
    });
  }));

  app.querySelectorAll('[data-go]').forEach((button) => {
    button.addEventListener('click', () => go(button.dataset.go));
  });

  if (step === 'shop') {
    bindShopInputs();
    document.getElementById('shop-next').addEventListener('click', () => {
      const problem = contactProblem();
      if (problem) {
        showShopError(problem);
        return;
      }
      go(STEPS[idx + 1]);
    });
    return;
  }

  app.querySelectorAll('[data-k]').forEach((button) => {
    button.addEventListener('click', () => {
      const { k: key, v: value } = button.dataset;
      if (state[key] !== value) {
        state[key] = value;
        if (key === 'concernState') state.symptom = null;
        answerChanged();
      }
      saveState();
      app.querySelectorAll('.tile').forEach((other) => {
        other.classList.toggle('on', other === button);
        other.setAttribute('aria-pressed', String(other === button));
      });
      later(() => go(key === 'symptom' ? 'result' : STEPS[idx + 1]), AUTO_NEXT_MS);
    });
  });

  const textarea = document.getElementById('txt');
  if (!textarea) return;
  const error = document.getElementById('err');
  const setText = (value) => {
    if (state.text !== value) answerChanged();
    state.text = value;
    error.hidden = true;
    saveState();
  };
  textarea.addEventListener('input', () => setText(textarea.value));
  app.querySelectorAll('[data-ex]').forEach((chip) => {
    chip.addEventListener('click', () => {
      textarea.value = EXAMPLES[Number(chip.dataset.ex)];
      setText(textarea.value);
    });
  });
  document.getElementById('go').addEventListener('click', () => {
    if (!state.text.trim()) {
      error.hidden = false;
      textarea.focus();
      return;
    }
    go('result');
  });
}

// ---------- 분석 중 → 결과 ----------
function renderAnalyzing(onDone) {
  app.innerHTML = `<div class="ana">${gomi('think', 150)}
    <h1 class="disp" tabindex="-1">고민을 분류하고 있어요</h1>
    <div class="steps" aria-live="polite">
      <div><i>${icon('check', 16)}</i>문장에서 키워드 찾기</div>
      <div><i>${icon('check', 16)}</i>문제 유형 나누기</div>
      <div><i>${icon('check', 16)}</i>학생 팀·기관 고르기</div>
    </div></div>`;
  const lines = [...app.querySelectorAll('.steps div')];
  lines.forEach((line, index) => later(() => line.classList.add('on'), PHASE_MS * (index + 1)));
  later(onDone, PHASE_MS * (lines.length + 1));
}

function whyTags(classification) {
  if (classification.isDefault) return ['키워드가 적어 진단부터'];
  const tags = [];
  classification.top.forEach((item) => {
    item.terms.forEach((term) => {
      if (!tags.includes(term)) tags.push(term);
    });
    if (item.answerEvidence.length && state.symptom && !tags.includes(state.symptom)) tags.push(state.symptom);
  });
  return tags;
}

function ring(score) {
  const arc = ((2 * Math.PI * 34 * score) / 100).toFixed(1);
  return `<div class="ring"><svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true">
      <circle cx="48" cy="48" r="40" fill="#fff" stroke="#22252B" stroke-width="2"/>
      <circle cx="48" cy="48" r="34" fill="none" stroke="#BFE7E3" stroke-width="10"/>
      <circle cx="48" cy="48" r="34" fill="none" stroke="#0F7F7A" stroke-width="10" stroke-linecap="round" stroke-dasharray="${arc} 999"/>
    </svg><b>${score}<small>관련도</small></b></div>`;
}

function memberAvatars(team) {
  return team.members.map((member) => {
    const [color, short] = MAJOR_BADGE[member.major];
    return `<span class="av"><i style="background:${color}">${short}</i>${esc(member.major)}</span>`;
  }).join('');
}

// 추천 인원은 고민 상태로 정한다(classifier.js teamRange).
function rangeText({ min, max }) {
  return `${min}~${max}명`;
}

function teamCard(team, range) {
  const { heading, line, ours, oursNote } = config.costs;
  const avatars = memberAvatars(team);
  return `<div class="card">
    <div class="h stu"><span class="ib" style="color:#6A4DE8">${icon('people', 20)}</span>추천 학생 팀<span class="r">${rangeText(range)} · ${esc(team.period)}</span></div>
    <div class="b">
      <div class="avatars">${avatars}</div>
      <div class="todo">${team.tasks.map((task) => `<div>${icon('check', 18)}<span>${keepParens(task)}</span></div>`).join('')}</div>
      <div class="cost"><span>${esc(heading)}</span><b>${esc(line)}</b><span>${esc(ours)} <span class="nw">(${esc(oursNote)})</span></span></div>
    </div></div>`;
}

function agencyCard(list) {
  return `<div class="card">
    <div class="h gov"><span class="ib" style="color:#0F7F7A">${icon('hall', 20)}</span>공공기관 연결</div>
    <div class="b">${list.map((agency) => `<div class="ag"><span><b>${esc(agency.name)}</b><small>${esc(agency.reason)}</small></span>${agency.confirmed ? '' : '<span class="pend">협력 미확인</span>'}</div>`).join('')}</div>
  </div>`;
}

// 가게 정보 단계(지역 다음): 가게 이름·위치·주소 묶음과 전화번호·연락 동의 묶음. 모두 필수(11/16).
// 가게 이름·위치는 발표 화면 알림에도 나온다. 전화번호와 동의는 시트에만 남고
// 발표 화면·집계·알림·과제 보드 어디에도 나오지 않는다.
const SHOP_FIELDS = ['store', 'loc', 'tel'];
const SHOP_KEYS = { store: 'store', loc: 'location', tel: 'phone' };

function shopCards() {
  return `<div class="store">
      <p class="store-h"><span class="ib">${icon('store', 18)}</span>가게<em class="req">필수</em></p>
      <label for="store">가게 이름</label>
      <input id="store" type="text" maxlength="${MAX_STORE_LENGTH}" autocomplete="off" enterkeyhint="next" placeholder="예: 조치원 ○○카페" value="${esc(state.store)}">
      <label for="loc">위치·주소</label>
      <input id="loc" type="text" maxlength="${MAX_LOCATION_LENGTH}" autocomplete="off" enterkeyhint="next" placeholder="예: 조치원역 앞" value="${esc(state.location)}" aria-describedby="loc-note">
      <small class="store-note" id="loc-note">상세 주소도 돼요 <span class="nw">(예: 조치원읍 ○○로 12, 2층)</span></small>
      <p class="store-err" role="alert"></p>
      <p>${icon('check', 16)}<span>가게 이름·위치는 발표 화면 알림에 나와요.</span></p>
    </div>
    <div class="store">
      <p class="store-h"><span class="ib">${icon('phone', 18)}</span>연락처<em class="req">필수</em></p>
      <label for="tel">전화번호</label>
      <input id="tel" type="tel" inputmode="tel" maxlength="13" autocomplete="off" enterkeyhint="done" placeholder="010-0000-0000" value="${esc(state.phone)}" aria-describedby="tel-note">
      <small class="store-note" id="tel-note">시연에서는 아무 번호나 넣어도 돼요</small>
      <label class="agree" for="agree"><input type="checkbox" id="agree"${state.consent ? ' checked' : ''}><span>연락 목적으로만 쓰고, 발표가 끝나면 지우는 데 동의해요</span></label>
      <p class="store-err" role="alert"></p>
      <p>${icon('check', 16)}<span>전화번호는 담당자만 봐요. 발표 화면에는 나오지 않아요.</span></p>
    </div>`;
}

function bindShopInputs() {
  SHOP_FIELDS.forEach((id, i) => {
    const input = document.getElementById(id);
    input.addEventListener('input', () => {
      if (state[SHOP_KEYS[id]] !== input.value) answerChanged();
      state[SHOP_KEYS[id]] = input.value;
      saveState();
      clearShopError();
    });
    // 엔터는 다음 칸으로 가거나 키보드만 닫는다(바로 다음 단계로 넘어가지 않게).
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const next = document.getElementById(SHOP_FIELDS[i + 1]);
      if (next) next.focus();
      else input.blur();
    });
  });
  document.getElementById('agree').addEventListener('change', (event) => {
    if (state.consent !== event.target.checked) answerChanged();
    state.consent = event.target.checked;
    saveState();
    clearShopError();
  });
}

// 가게 이름·위치·전화번호·동의를 확인한다. 문제가 있으면 [칸 id, 안내 문구]를 돌려준다.
function contactProblem() {
  if (!String(state.store ?? '').trim()) return ['store', '가게 이름을 적어 주세요'];
  if (!String(state.location ?? '').trim()) return ['loc', '위치나 주소를 적어 주세요'];
  if (!normalizePhone(state.phone)) {
    return ['tel', String(state.phone ?? '').trim() ? '전화번호를 다시 확인해 주세요 (숫자 9~11자리)' : '전화번호를 적어 주세요'];
  }
  if (!state.consent) return ['agree', '연락 동의에 체크해 주세요'];
  return null;
}

function showShopError([field, message]) {
  const target = document.getElementById(field);
  target.closest('.store').querySelector('.store-err').textContent = message;
  (field === 'agree' ? target.closest('label') : target).classList.add('bad');
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.focus({ preventScroll: true });
}

function clearShopError() {
  app.querySelectorAll('.store .store-err').forEach((error) => {
    error.textContent = '';
  });
  app.querySelectorAll('.store .bad').forEach((element) => element.classList.remove('bad'));
}

function showResult(analysis) {
  const { classification, team } = analysis;
  const [first, second] = classification.top;
  app.innerHTML = `<span class="badge">시연용 규칙 기반 분석</span>
    <div class="rhead"><span class="spk">${icon('spark', 20)}</span><span class="k">분석 완료!</span>
      <div class="rrow">${ring(ringScore(first.score, classification.isDefault))}
        <div><span class="rtype">${esc(categoryName(first.id))}</span><h1 class="rtitle disp" tabindex="-1">${esc(classification.title)}</h1></div>
      </div>
      ${second ? `<div class="alt"><span>다음으로 가까운 유형<b>${esc(categoryName(second.id))}</b></span><span class="nw">관련도 ${ringScore(second.score)}</span></div>` : ''}
      <div class="why" aria-label="찾은 키워드">${whyTags(classification).map((tag) => `<span>#${esc(tag)}</span>`).join('')}</div>
    </div>
    ${team ? teamCard(team, teamRange(state.concernState)) : ''}
    ${agencyCard(analysis.agencies)}
    <div class="human">${gomi('happy', 44)}<span class="human-text"><span>실제 운영에서는 담당자가 이&nbsp;분석을 확인한 뒤 연결해요.</span><span>AI는 추천만 해요.</span></span></div>`;

  if (state.submittedId) {
    showDock(`<button type="button" class="btn white" id="again">처음부터 다시 ${icon('left', 20)}</button>`);
    document.getElementById('again').addEventListener('click', restart);
    return;
  }
  showDock(`<button type="button" class="btn" id="fin">이 고민 제출하기 ${icon('right', 22)}</button>`);
  document.getElementById('fin').addEventListener('click', () => {
    if (contactProblem()) {
      go('shop');
      return;
    }
    const id = newId();
    const record = buildSubmission(currentInput(), analysis, {
      id,
      ts: new Date().toISOString(),
      storeName: state.store,
      location: state.location,
      phone: state.phone,
      contactConsent: state.consent,
    });
    state.submittedId = id;
    state.submitStatus = remainingSubmissions() > 0 ? 'sending' : 'limit';
    saveState();
    if (state.submitStatus === 'sending') sendSubmission(record);
    go('done');
  });
}

function renderResult(route) {
  const analysis = analyze(currentInput(), config, agencies);
  const key = currentKey();
  if (route === 'result' && state.analysisShownFor !== key) {
    renderAnalyzing(() => {
      state.analysisShownFor = key;
      saveState();
      showResult(analysis);
      app.querySelector('h1')?.focus({ preventScroll: true });
    });
    return;
  }
  showResult(analysis);
  if (route === 'done') showDone();
}

// ---------- 제출과 완료 화면 ----------
function sendSubmission(record) {
  submitting = submit(record)
    .then((result) => result.mode)
    .catch(() => 'offline')
    .then((mode) => {
      submitting = null;
      if (state.submittedId !== record.id) return;
      state.submitStatus = mode;
      saveState();
      if (routeOf(location.hash) === 'done') showDone();
    });
}

function doneCopy() {
  // 보내는 도중 새로고침했다면 기기에 남은 접수를 다음에 다시 보낸다.
  const status = state.submitStatus === 'sending' && !submitting ? 'offline' : state.submitStatus;
  if (status === 'limit') {
    return {
      mood: 'happy',
      title: '체험을 마쳤어요',
      body: `이 기기는 발표 화면에<br>${MAX_SUBMISSIONS_PER_DEVICE}번까지 올릴 수 있어요`,
      note: '이번 고민은 올라가지 않았어요',
    };
  }
  if (status === 'offline') {
    return {
      mood: 'happy',
      title: '이 기기에 저장했어요',
      body: isConfigured() ? '인터넷이 연결되면<br>발표 화면으로 다시 보내요' : '서버 연결 전이라<br>이 기기에서만 보여요',
      note: '현재 오프라인 시연 모드',
    };
  }
  return {
    arrow: true,
    mood: 'wow',
    title: '발표 화면을 봐주세요!',
    body: '방금 올린 고민이<br>바로 올라갔어요',
    note: status === 'sending' ? '보내는 중이에요' : '',
  };
}

function showDone() {
  const copy = doneCopy();
  const element = overlay('done', 'status');
  element.innerHTML = `
    <span class="spk" style="left:24px;top:60px">${icon('spark', 30)}</span>
    <span class="spk" style="right:30px;top:120px;color:#fff">${icon('spark', 20)}</span>
    <span class="spk" style="left:40px;bottom:140px;color:#BFE7E3">${icon('spark', 24)}</span>
    ${copy.arrow ? `<span class="arrow">${icon('up', 30)}</span>` : ''}${gomi(copy.mood, 150)}
    <h2 class="disp" tabindex="-1">${copy.title}</h2>
    <p>${copy.body}</p>
    ${copy.note ? `<p class="status">${copy.note}</p>` : ''}
    <div class="row">
      <button type="button" class="btn white" id="again">처음부터 다시 ${icon('left', 20)}</button>
      <button type="button" class="link" id="close-done">결과 다시 보기</button>
      <button type="button" class="link" id="to-board">학생 과제 보드 보기</button>
    </div>`;
  element.querySelector('#again').addEventListener('click', restart);
  element.querySelector('#close-done').addEventListener('click', () => closeTo('result'));
  element.querySelector('#to-board').addEventListener('click', () => go('board'));
}

function restart() {
  state = emptyState();
  saveState();
  lastProgIdx = null;
  go('landing');
}

// ---------- 학생 과제 보드 ----------
// 사장님 고민(예시 + 방금 올라온 접수)을 학생 과제 카드로 보여 준다. 원문은 쓰지 않고 업종·지역·유형만 쓴다.
// 처음 들어오면 학년·전공·선호 과제 유형(여러 개)을 고른다. 추천 전공·선호 유형은 배지와 순서로만 보여 주고,
// 맞지 않아도 지원할 수 있다. 지원·취소는 시트 '지원' 탭에 남는다(이름·연락처는 받지 않는다).
const PROFILE_KEY = 'sls.board.profile.v1';
const GRADES = ['1학년', '2학년', '3학년', '4학년'];
const CANCEL_WAIT_MS = 3000;
const MAJOR_HINTS = {
  '경영·사회': '경영·경제·사회과학 등',
  'IT·이공': '컴퓨터·공학·자연과학 등',
  '디자인·예체능': '디자인·영상·미술 등',
};

function loadProfile() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PROFILE_KEY));
    return saved && typeof saved === 'object' ? saved : null;
  } catch {
    return null;
  }
}

function saveProfile(value) {
  try {
    sessionStorage.setItem(PROFILE_KEY, JSON.stringify(value));
  } catch {
    // 저장이 막혀도 이번 화면에서는 동작한다.
  }
}

function hasMajor() {
  return MAJORS.includes(profile?.major);
}

function myPrefs() {
  return Array.isArray(profile?.prefs) ? profile.prefs : [];
}

function studentCategories() {
  return config.categories.filter((category) => !category.agencyOnly);
}

function shortName(id) {
  return config.categories.find((category) => category.id === id)?.short ?? '';
}

function industryInfo(value) {
  const item = INDUSTRIES.find((entry) => entry.value === value);
  return { label: item?.label ?? value, icon: item?.icon ?? 'dots', bg: item?.bg ?? '#F5F7FA' };
}

function ago(ts) {
  const minutes = Math.round((Date.now() - Date.parse(ts)) / 60000);
  if (Number.isNaN(minutes)) return '';
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  return `${Math.floor(minutes / 60)}시간 전`;
}

function toTask(key, source, item, categoryIds) {
  const known = categoryIds
    .map((id) => config.categories.find((category) => category.id === id))
    .filter(Boolean);
  // 카드 이름은 학생이 맡을 유형으로 단다. 자금·세무가 함께 걸린 고민은 그 부분만 기관으로 간다고 따로 적는다.
  const studentPart = known.find((category) => !category.agencyOnly);
  return {
    key,
    source,
    taskId: String(item.id ?? 'unknown'),
    ts: item.ts,
    industry: item.industry,
    area: item.area,
    categoryId: (studentPart ?? known[0])?.id ?? null,
    alsoAgency: Boolean(studentPart) && known.some((category) => category.agencyOnly),
    team: known.length ? matchTeam({ top: known.map(({ id }) => ({ id })) }, config) : null,
    range: teamRange(item.concernState),
  };
}

// 서버에 연결되면 서버의 최근 접수, 아니면 이 기기에서 올린 접수를 쓴다(대시보드와 같은 규칙).
function boardTasks() {
  const live = isConfigured() && liveRecent
    ? liveRecent.map((item) => toTask(`live|${item.id ?? item.ts}|${item.category}|${item.area}`, 'live', item, [item.category]))
    : getLocalSubmissions().slice().reverse()
      .map((item) => toTask(`device|${item.id}`, 'device', item, (item.categories ?? []).map((entry) => entry.id)));
  const seeds = (seedItems ?? [])
    .map((item) => toTask(`seed|${item.id}`, 'seed', item, item.categories.map((entry) => entry.id)));
  return [...live.slice(0, LIVE_TASKS_SHOWN), ...seeds];
}

function fitsMe(task) {
  return hasMajor() && task.team.members.some((member) => member.major === profile.major);
}

function likesIt(task) {
  return myPrefs().includes(task.categoryId);
}

function boardHero() {
  return `<span class="badge">시연용 · 예시 과제 포함</span>
    <div class="board-hero"><span class="spk">${icon('spark', 20)}</span>${gomi('happy', 72)}
      <div><h1 class="disp" tabindex="-1">학생 과제 보드</h1><p>사장님들이 올린 고민이 과제가 돼요.<br>혼자도, 팀으로도 지원할 수 있어요.</p></div>
    </div>`;
}

// 학년·전공·선호 과제 유형 고르기. 학년과 전공은 하나씩, 선호 유형은 여러 개(안 골라도 됨).
// pending: 둘러보다가 '지원하기'를 눌러 들어온 경우 그 과제. 고르고 나면 바로 그 과제의 지원 창을 연다.
function renderProfilePicker(pending = null) {
  const draft = {
    grade: profile?.grade ?? '',
    major: MAJORS.includes(profile?.major) ? profile.major : '',
    prefs: [...myPrefs()],
  };
  const majorTiles = MAJORS.map((major) => {
    const [color, short] = MAJOR_BADGE[major];
    return `<button type="button" class="tile${draft.major === major ? ' on' : ''}" data-major="${esc(major)}" aria-pressed="${draft.major === major}">`
      + `<span class="ib major-ib" style="background:${color}">${short}</span>`
      + `<span><b>${esc(major)}</b><small>${esc(MAJOR_HINTS[major])}</small></span>`
      + `<span class="ok">${icon('check', 16)}</span></button>`;
  }).join('');
  app.innerHTML = `${boardHero()}
    <h2 class="q disp">나를 알려 주세요</h2>
    <p class="exh label">${pending ? '지원하려면 학년과 전공을 먼저 알려 주세요. 팀을 짤 때 써요.' : '고른 전공과 선호 유형의 과제를 먼저 보여 드려요. 다른 과제도 지원할 수 있어요.'}</p>
    <p class="pick-h" id="grade-h">학년</p>
    <div class="picks four" role="group" aria-labelledby="grade-h">${GRADES.map((grade) =>
      `<button type="button" class="pick" data-grade="${grade}" aria-pressed="${draft.grade === grade}">${grade}</button>`).join('')}</div>
    <p class="pick-h" id="major-h">전공</p>
    <div class="list" role="group" aria-labelledby="major-h">${majorTiles}</div>
    <p class="pick-h" id="pref-h">선호 과제 유형 <small>여러 개 골라도 돼요</small></p>
    <div class="picks" role="group" aria-labelledby="pref-h">${studentCategories().map((category) =>
      `<button type="button" class="pick" data-pref="${category.id}" aria-pressed="${draft.prefs.includes(category.id)}">${esc(category.short)}</button>`).join('')}</div>
    <p class="pick-err" id="pick-err" role="alert"></p>
    <button type="button" class="link-btn" id="profile-skip">건너뛰고 둘러보기</button>`;

  const error = document.getElementById('pick-err');
  // 학년·전공은 하나만 고르고, 고른 것을 한 번 더 누르면 선택이 풀린다(선호 유형은 원래 켜고 끄기).
  app.querySelectorAll('[data-grade]').forEach((button) => {
    button.addEventListener('click', () => {
      draft.grade = draft.grade === button.dataset.grade ? '' : button.dataset.grade;
      app.querySelectorAll('[data-grade]').forEach((other) => other.setAttribute('aria-pressed', String(other.dataset.grade === draft.grade)));
      error.textContent = '';
    });
  });
  app.querySelectorAll('[data-major]').forEach((button) => {
    button.addEventListener('click', () => {
      draft.major = draft.major === button.dataset.major ? '' : button.dataset.major;
      app.querySelectorAll('[data-major]').forEach((other) => {
        const on = other.dataset.major === draft.major;
        other.classList.toggle('on', on);
        other.setAttribute('aria-pressed', String(on));
      });
      error.textContent = '';
    });
  });
  app.querySelectorAll('[data-pref]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.pref;
      draft.prefs = draft.prefs.includes(id) ? draft.prefs.filter((item) => item !== id) : [...draft.prefs, id];
      button.setAttribute('aria-pressed', String(draft.prefs.includes(id)));
    });
  });
  const finish = (value) => {
    profile = value;
    saveProfile(value);
    dock.hidden = true;
    dock.innerHTML = '';
    drawBoard();
    window.scrollTo(0, 0);
    app.querySelector('h1')?.focus({ preventScroll: true });
    if (pending && hasMajor()) showApply(pending);
  };
  document.getElementById('profile-skip').addEventListener('click', () => finish({ skip: true, grade: '', major: '', prefs: [] }));
  showDock(`<button type="button" class="btn pur" id="profile-done">${pending ? '지원 계속하기' : '과제 보러 가기'} ${icon('right', 22)}</button>`);
  document.getElementById('profile-done').addEventListener('click', () => {
    if (!draft.grade || !draft.major) {
      error.textContent = !draft.grade && !draft.major ? '학년과 전공을 골라 주세요' : `${draft.grade ? '전공' : '학년'}을 골라 주세요`;
      (app.querySelector(draft.grade ? '[data-major]' : '[data-grade]'))?.focus();
      return;
    }
    // 화면에 보이는 순서대로 저장한다.
    const prefs = studentCategories().map((category) => category.id).filter((id) => draft.prefs.includes(id));
    finish({ skip: false, grade: draft.grade, major: draft.major, prefs });
  });
}

function profileLine() {
  if (!profile || profile.skip || !hasMajor()) return '나를 알려 주지 않았어요';
  const prefs = myPrefs().map(shortName).filter(Boolean);
  return `나 <b>${esc(profile.grade)} · ${esc(profile.major)}</b>${prefs.length ? `<small>선호 ${esc(prefs.join(', '))}</small>` : ''}`;
}

function applyButton(task) {
  const applied = appliedTasks.get(task.key);
  if (!applied) {
    return `<button type="button" class="btn pur sm" data-apply="${esc(task.key)}">지원하기 ${icon('right', 20)}</button>`;
  }
  // 지원한 카드는 한 번 누르면 빨간 확인 버튼으로 바뀌고, 3초 안에 한 번 더 누르면 취소된다.
  if (cancelArmed === task.key) {
    return `<button type="button" class="btn red sm" data-cancel="${esc(task.key)}">지원 취소할까요?</button>`;
  }
  return `<button type="button" class="btn white sm" data-arm="${esc(task.key)}">${applied.size === 1 ? '혼자' : `${applied.size}명 팀으로`} 지원했어요 ${icon('check', 20)}</button>`;
}

function taskCard(task) {
  const info = industryInfo(task.industry);
  const when = task.source === 'seed'
    ? '<span class="when">예시</span>'
    : `<span class="when new">${task.source === 'device' ? '이 기기 · ' : ''}${esc(ago(task.ts))}</span>`;
  const badges = `${fitsMe(task) ? '<span class="fit">내 전공 추천</span>' : ''}${likesIt(task) ? '<span class="fit like">선호 유형</span>' : ''}`;
  return `<article class="card task">
    <div class="h stu"><span class="ib" style="background:${info.bg}">${icon(info.icon, 20)}</span><span class="where">${esc(info.label)} · ${esc(task.area)}</span>${when}</div>
    <div class="b">
      <span class="rtype">${esc(categoryName(task.categoryId))}</span>${badges}
      ${task.alsoAgency ? `<p class="also">${icon('hall', 16)}자금·세무는 기관으로 연결돼요</p>` : ''}
      <div class="todo">${task.team.tasks.map((item) => `<div>${icon('check', 18)}<span>${keepParens(item)}</span></div>`).join('')}</div>
      <div class="task-meta"><div class="avatars">${memberAvatars(task.team)}</div><span class="nw">추천 ${rangeText(task.range)} · ${esc(task.team.period)}</span></div>
      ${applyButton(task)}
    </div>
  </article>`;
}

function drawBoard() {
  const all = boardTasks();
  const tasks = all.filter((task) => task.team).slice(0, BOARD_MAX);
  const agencyOnly = all.filter((task) => !task.team && task.categoryId).length;
  // 내 전공 추천·선호 유형 과제를 먼저(둘 다 맞으면 맨 위), 나머지는 그 아래에 그대로 둔다.
  const score = (task) => Number(fitsMe(task)) + Number(likesIt(task));
  const ordered = tasks.map((task, i) => ({ task, i }))
    .sort((a, b) => score(b.task) - score(a.task) || a.i - b.i)
    .map(({ task }) => task);
  const liveCount = tasks.filter((task) => task.source !== 'seed').length;
  let status = `방금 들어온 과제 ${liveCount}건 · 예시 과제 ${tasks.length - liveCount}건`;
  if (!isConfigured()) status = '서버 연결 전이라 이 기기 접수와 예시 과제만 보여요';
  else if (liveFailed && !liveRecent) status = '서버에 연결하지 못해 예시 과제만 보여요';
  if (hasMajor()) status += ` · 내 전공 추천 ${tasks.filter(fitsMe).length}건`;
  if (myPrefs().length) status += ` · 선호 유형 ${tasks.filter(likesIt).length}건`;

  app.innerHTML = `${boardHero()}
    <div class="mymajor">
      <span>${profileLine()}</span>
      <button type="button" id="change-major">${icon('edit', 14)}${hasMajor() ? '바꾸기' : '알려 주기'}</button>
    </div>
    <p class="board-status" aria-live="polite">${esc(status)}</p>
    <div class="tasks">${ordered.map(taskCard).join('') || '<p class="loading">아직 올라온 과제가 없어요.</p>'}</div>
    ${agencyOnly ? `<p class="fine">자금·세무 고민 ${agencyOnly}건은 학생 과제가 아니라 기관으로 연결돼서 여기엔 없어요.</p>` : ''}
    <div class="more">
      <a href="${hashOf('landing')}">${icon('left', 18)}처음 화면</a>
      <a href="dashboard.html">${icon('hall', 18)}발표 화면 보기</a>
    </div>`;

  document.getElementById('change-major').addEventListener('click', () => {
    renderProfilePicker();
    window.scrollTo(0, 0);
  });
  app.querySelectorAll('[data-apply]').forEach((button) => {
    button.addEventListener('click', () => {
      const task = tasks.find((item) => item.key === button.dataset.apply);
      if (!task) return;
      // 학년·전공을 모르면 팀 자리를 채울 수 없으니 먼저 묻는다.
      if (!hasMajor() || !profile?.grade) {
        renderProfilePicker(task);
        window.scrollTo(0, 0);
        return;
      }
      showApply(task);
    });
  });
  app.querySelectorAll('[data-arm]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.arm;
      cancelArmed = key;
      drawBoard();
      later(() => {
        if (cancelArmed !== key) return;
        cancelArmed = null;
        if (app.querySelector('.tasks')) drawBoard();
      }, CANCEL_WAIT_MS);
    });
  });
  app.querySelectorAll('[data-cancel]').forEach((button) => {
    button.addEventListener('click', () => {
      const applied = appliedTasks.get(button.dataset.cancel);
      if (applied?.applyId) sendCancel(applied.applyId);
      appliedTasks.delete(button.dataset.cancel);
      cancelArmed = null;
      drawBoard();
    });
  });
}

function showBoard() {
  if (profile === null) renderProfilePicker();
  else drawBoard();
}

// 청중이 질의응답 중에 올리는 고민도 카드로 보이게 10초마다 다시 받아 온다(나를 고르는 중에는 화면을 건드리지 않는다).
function refreshBoard(gen) {
  if (!isConfigured()) return;
  fetchSummary()
    .then((summary) => {
      liveRecent = summary.recent ?? [];
      liveFailed = false;
    })
    .catch(() => {
      liveFailed = true;
    })
    .then(() => {
      if (gen !== boardGen || routeOf(location.hash) !== 'board') return;
      if (app.querySelector('.tasks')) drawBoard();
      later(() => refreshBoard(gen), BOARD_REFRESH_MS);
    });
}

function renderBoard() {
  boardGen += 1;
  const gen = boardGen;
  if (profile === undefined) profile = loadProfile();
  cancelArmed = null;
  if (seedItems) {
    showBoard();
  } else {
    app.innerHTML = '<p class="loading">과제를 불러오는 중이에요.</p>';
    loadJson('data/seed.json')
      .then((data) => {
        seedItems = data.items;
      })
      .catch(() => {
        seedItems = [];
      })
      .then(() => {
        if (gen !== boardGen || routeOf(location.hash) !== 'board') return;
        showBoard();
        app.querySelector('h1')?.focus({ preventScroll: true });
      });
  }
  refreshBoard(gen);
}

// 지원하기 → 인원 고르기(1명~추천 최대) → 혼자 / 학생 찾기 / 친구와 함께 → 자리 채우기

function applyChoices(size) {
  if (size === 1) {
    return '<button type="button" class="choice" data-mode="solo"><b>혼자 지원하기</b><small>과제를 혼자 맡아서 해요</small></button>';
  }
  return `<button type="button" class="choice" data-mode="match"><b>맞는 학생 찾아 주세요</b><small>추천 전공 학생과 ${size}명 팀을 맺어요</small></button>
    <button type="button" class="choice" data-mode="friends"><b>같이 할 친구가 있어요</b><small>친구 ${size - 1}명을 초대해요</small></button>`;
}

function showApply(task) {
  const info = industryInfo(task.industry);
  const { min, max } = task.range;
  const sizes = Array.from({ length: max }, (_, i) => i + 1);
  let size = min;
  const element = overlay('done team', 'dialog', '과제 지원');
  element.setAttribute('aria-modal', 'true');
  element.innerHTML = `${gomi('happy', 72)}
    <h2 class="disp" tabindex="-1">몇 명이서 할까요?</h2>
    <p>${esc(info.label)} · ${esc(task.area)} · ${esc(categoryName(task.categoryId))}</p>
    ${hasMajor() && !fitsMe(task) ? '<p class="status">추천 전공은 아니지만 지원할 수 있어요</p>' : ''}
    <div class="sizes" role="group" aria-label="팀 인원" style="--n:${max}">${sizes.map((n) => `<button type="button" class="size" data-size="${n}" aria-pressed="${n === size}"><b>${n === 1 ? '혼자' : `${n}명`}</b>${n >= min ? '<small>추천</small>' : ''}</button>`).join('')}</div>
    <p class="size-hint">추천은 ${rangeText(task.range)}이에요. 혼자도 지원할 수 있어요.</p>
    <div class="row" id="apply-choices">${applyChoices(size)}</div>
    <div class="row"><button type="button" class="link" id="team-close">보드로 돌아가기</button></div>`;

  const bindChoices = () => {
    element.querySelectorAll('[data-mode]').forEach((button) => {
      button.addEventListener('click', () => runApply(element, task, size, button.dataset.mode));
    });
  };
  element.querySelectorAll('[data-size]').forEach((button) => {
    button.addEventListener('click', () => {
      size = Number(button.dataset.size);
      element.querySelectorAll('[data-size]').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
      element.querySelector('#apply-choices').innerHTML = applyChoices(size);
      bindChoices();
    });
  });
  bindChoices();
  element.querySelector('#team-close').addEventListener('click', closeApply);
  element.querySelector('h2').focus({ preventScroll: true });
}

// 학생 찾기로 채운 자리의 학년은 시연용 예시다. 같은 과제는 늘 같은 학년이 나오게 과제 키로 정한다.
function sampleGrade(seed) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return GRADES[hash % GRADES.length];
}

function seatLabel(grade, major) {
  return `<small>${grade ? `${esc(grade)}<br>` : ''}${esc(major)}</small>`;
}

function runApply(element, task, size, mode) {
  const recommended = task.team.members.flatMap((member) => Array(member.count).fill(member.major));
  // 내 전공이 추천에 있으면 그 자리를 내가 맡는다(지원 전에 학년·전공을 꼭 받는다).
  // 고른 인원이 추천 전공보다 많으면 남는 자리도 그 과제의 추천 전공을 차례로 돌아가며 채운다.
  const mine = profile.major;
  const others = [...recommended];
  if (others.includes(mine)) others.splice(others.indexOf(mine), 1);
  for (let k = 0; others.length < size - 1; k += 1) others.push(recommended[k % recommended.length]);
  const seats = [{ me: true, major: mine }, ...others.slice(0, size - 1).map((major) => ({ major }))];
  const friends = mode === 'friends';
  const applyId = newId();
  appliedTasks.set(task.key, { size, mode, applyId });
  const sent = sendApplication({
    id: applyId,
    taskId: task.taskId,
    taskSource: task.source,
    industry: task.industry,
    area: task.area,
    category: task.categoryId,
    grade: profile.grade,
    major: mine,
    prefs: myPrefs(),
    size,
    mode,
  });

  const seatHtml = (seat, i) => {
    if (seat.me) return `<span class="seat me"><i>나</i>${seatLabel(profile.grade, seat.major)}</span>`;
    // 친구 초대 빈자리는 아직 사람이 없어서 추천 전공만 적는다.
    if (friends) return `<span class="seat invite"><i>+</i>${seatLabel('', seat.major)}</span>`;
    const [color, short] = MAJOR_BADGE[seat.major];
    return `<span class="seat"><i style="--c:${color}">${short}</i>${seatLabel(sampleGrade(`${task.key}|${i}`), seat.major)}</span>`;
  };
  const title = { solo: '혼자 지원했어요!', match: '맞는 학생을 찾는 중이에요', friends: `${size}명 팀으로 지원했어요!` }[mode];
  const message = {
    solo: '사장님과 담당자가 확인하면 과제가 정해져요.',
    match: `추천 전공 학생과 ${size}명 팀을 맺어요`,
    friends: '실제 서비스에서는 여기서 팀 소개를 적고<br>팀원에게 초대 링크를 보내요',
  }[mode];
  element.innerHTML = `${gomi('happy', 96)}
    <h2 class="disp" tabindex="-1" id="team-title">${title}</h2>
    <div class="seats">${seats.map(seatHtml).join('')}</div>
    <p id="team-msg">${message}</p>
    <p class="status" id="team-note" hidden></p>
    <div class="row"><button type="button" class="btn white" id="team-close">보드로 돌아가기</button></div>`;
  element.querySelector('#team-close').addEventListener('click', closeApply);
  element.querySelector('h2').focus({ preventScroll: true });

  const filling = [...element.querySelectorAll(friends ? '.seat.me' : '.seat')];
  filling.forEach((seat, i) => later(() => seat.classList.add('on'), SEAT_MS * (i + 1)));
  later(() => {
    if (mode === 'match') element.querySelector('#team-title').textContent = '팀이 꾸려졌어요!';
    if (mode !== 'friends') {
      element.querySelector('#team-msg').innerHTML = '사장님과 담당자가 확인하면 정해져요.<br>활동이 끝나면 확인서와 포트폴리오를 받아요.';
    }
    sent.then((result) => {
      const note = element.querySelector('#team-note');
      if (!note) return;
      const saved = result.mode === 'online' ? '지원 기록을 남겼어요' : '서버에 연결되지 않아 기록은 남지 않았어요';
      note.textContent = mode === 'match' ? `${saved} · 팀원은 시연용 예시예요` : saved;
      note.hidden = false;
    });
  }, SEAT_MS * (filling.length + 1));
}

function closeApply() {
  removeOverlay();
  showBoard();
}

// ---------- 그리기 ----------
function render() {
  clearTimers();
  const route = routeOf(location.hash);
  const allowed = allowedRoute(route);
  if (allowed !== route) {
    location.replace(hashOf(allowed));
    return;
  }

  removeOverlay();
  dock.hidden = true;
  dock.innerHTML = '';
  backTo = prevRoute;
  app.dataset.screen = route;
  if (!STEPS.includes(route)) lastProgIdx = null;

  if (route === 'landing' || route === 'about') {
    renderLanding();
    if (route === 'about') showAbout();
  } else if (route === 'board') {
    renderBoard();
  } else if (STEPS.includes(route)) {
    renderStep(route);
  } else {
    renderResult(route);
  }

  prevRoute = route;
  window.scrollTo(0, 0);
  const heading = document.querySelector('.done h2, .modal h2') ?? app.querySelector('h1');
  heading?.focus({ preventScroll: true });
}

function onKey(event) {
  if (event.key !== 'Escape') return;
  if (document.querySelector('.done.team')) closeApply();
  else if (routeOf(location.hash) === 'about') closeAbout();
}

// 발표장처럼 접속이 몰릴 때 한 번 실패해도 멈추지 않게 다시 시도한다.
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
  document.getElementById('brand').innerHTML = `${gomi('happy', 40)}세종 로컬 해결소`;
  try {
    const [categories, agencyData] = await Promise.all([
      loadJson('data/categories.json'),
      loadJson('data/agencies.json'),
    ]);
    config = categories;
    agencies = agencyData.agencies;
  } catch {
    app.innerHTML = `<p class="loading">화면을 불러오지 못했어요.</p>
      <button type="button" class="btn" onclick="location.reload()">다시 시도하기</button>`;
    return;
  }
  window.addEventListener('hashchange', render);
  document.addEventListener('keydown', onKey);
  render();
  flushPending();
}

start();
