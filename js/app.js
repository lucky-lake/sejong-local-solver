// 1분 체험: 라우팅, 화면 렌더링, 진행 상태.
// 화면 구성·문구·상호작용은 확정 시안(design/prototype-index.html)을 따르고,
// 분류는 classifier.js, 제출은 api.js(서버 연결 + 오프라인 대체)를 쓴다.
import { analyze, buildSubmission, ringScore, MAX_TEXT_LENGTH } from './classifier.js';
import { submit, flushPending, isConfigured, remainingSubmissions, MAX_SUBMISSIONS_PER_DEVICE } from './api.js';
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
const STEPS = ['industry', 'area', 'state', 'concern'];
const ROUTES = [...STEPS, 'result', 'done'];
const AUTO_NEXT_MS = 220;
const PHASE_MS = 360;
const STATE_KEY = 'sls.flow.v2';

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

function emptyState() {
  return {
    industry: null,
    area: null,
    concernState: null,
    symptom: null,
    text: '',
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
  return path === '/about' ? 'about' : 'landing';
}

function hashOf(route) {
  if (route === 'landing') return '#/';
  if (route === 'about') return '#/about';
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
  const items = [['industry', state.industry], ['area', state.area], ['state', stateLabel()]]
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
  document.querySelector('.done')?.remove();
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
    <p class="fine">가게 이름·연락처 같은 개인정보는 받지 않아요</p>
    <div class="more">
      <a href="dashboard.html">${icon('hall', 18)}발표 화면 보기</a>
      <a href="${hashOf('about')}">${icon('question', 18)}어떻게 운영돼요?</a>
    </div>`;
}

function showAbout() {
  const element = overlay('done about', 'dialog', '운영 방식');
  element.setAttribute('aria-modal', 'true');
  element.innerHTML = `${gomi('happy', 110)}
    <h2 class="disp" tabindex="-1">이렇게 운영돼요</h2>
    <ol>
      <li>사장님이 고민을 올려요</li>
      <li>학생 팀이 과제를 골라 지원해요</li>
      <li>가게를 찾아가 진단하고 결과물을 적용해요</li>
      <li>자금·세무는 공공기관으로 연결해요</li>
      <li>학생은 활동 인증과 포트폴리오를 받아요</li>
    </ol>
    <div class="row"><button type="button" class="btn white" id="close-about">닫기</button></div>`;
  element.querySelector('#close-about').addEventListener('click', () => closeTo('landing'));
}

// ---------- 질문 4개 ----------
function renderStep(step) {
  const idx = STEPS.indexOf(step);
  let html = progress(idx, lastProgIdx) + trail(idx);

  if (step === 'industry') {
    html += `<h1 class="q disp" tabindex="-1">어떤 가게를 운영하세요?</h1><div class="grid">${INDUSTRIES.map((item) => tile('industry', item)).join('')}</div>`;
  } else if (step === 'area') {
    html += `<h1 class="q disp" tabindex="-1">가게는 어디에 있어요?</h1><div class="list">${AREAS.map((item) => tile('area', item)).join('')}</div>`;
  } else if (step === 'state') {
    html += `<h1 class="q disp" tabindex="-1">고민은 얼마나 정리됐어요?</h1><div class="list">${CONCERN_STATES.map((item) => tile('concernState', item)).join('')}</div>`;
  } else if (isUnknown()) {
    html += `<h1 class="q disp" tabindex="-1">요즘 가장 아쉬운 건요?</h1><div class="grid">${SYMPTOMS.map((item) => tile('symptom', item)).join('')}</div>`;
  } else {
    html += `<div class="ask">${gomi('worry', 92)}<h1 class="bubble" tabindex="-1">어떤 고민이 있으세요?</h1></div>
      <label for="txt" class="exh label">한두 문장으로 적어 주세요 (가게 이름·연락처는 빼고)</label>
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

function teamCard(team) {
  const { heading, line, ours, oursNote } = config.costs;
  const avatars = team.members.map((member) => {
    const [color, short] = MAJOR_BADGE[member.major];
    return `<span class="av"><i style="background:${color}">${short}</i>${esc(member.major)}${member.count > 1 ? ` ${member.count}명` : ''}</span>`;
  }).join('');
  return `<div class="card">
    <div class="h stu"><span class="ib" style="color:#6A4DE8">${icon('people', 20)}</span>추천 학생 팀<span class="r">${team.size}명 · ${esc(team.period)}</span></div>
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
    ${team ? teamCard(team) : ''}
    ${agencyCard(analysis.agencies)}
    <div class="human">${gomi('happy', 44)}<span class="human-text"><span>실제 운영에서는 담당자가 이&nbsp;분석을 확인한 뒤 연결해요.</span><span>AI는 추천만 해요.</span></span></div>`;

  if (state.submittedId) {
    showDock(`<button type="button" class="btn white" id="again">처음부터 다시 ${icon('left', 20)}</button>`);
    document.getElementById('again').addEventListener('click', restart);
    return;
  }
  showDock(`<button type="button" class="btn" id="fin">이 고민 제출하기 ${icon('right', 22)}</button>`);
  document.getElementById('fin').addEventListener('click', () => {
    const id = newId();
    const record = buildSubmission(currentInput(), analysis, { id, ts: new Date().toISOString() });
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
    </div>`;
  element.querySelector('#again').addEventListener('click', restart);
  element.querySelector('#close-done').addEventListener('click', () => closeTo('result'));
}

function restart() {
  state = emptyState();
  saveState();
  lastProgIdx = null;
  go('landing');
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
  } else if (STEPS.includes(route)) {
    renderStep(route);
  } else {
    renderResult(route);
  }

  prevRoute = route;
  window.scrollTo(0, 0);
  const heading = document.querySelector('.done h2') ?? app.querySelector('h1');
  heading?.focus({ preventScroll: true });
}

function onKey(event) {
  if (event.key === 'Escape' && routeOf(location.hash) === 'about') closeTo('landing');
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
