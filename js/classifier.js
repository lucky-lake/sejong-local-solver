// 규칙 기반 분류기. 화면·저장소에 손대지 않는 순수 함수만 둔다.
// 점수 = 키워드 일치 수 × 가중치 + 진단 답 가중치 + 업종 보정 (SPEC 3-2)

export const MAX_TEXT_LENGTH = 200;

const DEFAULT_CATEGORY_ID = 'customer';
const AGENCY_CATEGORY_ID = 'funding';
const SUPPORT_QUESTION_INDEX = 3;
const UNAWARE_OF_SUPPORT = '몰랐다';

// 결과 화면 점수 링(0~100)에 쓰는 환산. 근거가 하나면 64점, 둘이면 82점, 셋 이상이면 95점에서 멈춘다.
// 걸린 근거가 없을 때는 시안대로 60점에 '키워드가 적어 진단부터'를 함께 보인다.
const RING_BASE = 46;
const RING_PER_POINT = 9;
const RING_MAX = 95;
const RING_DEFAULT = 60;

// 띄어쓰기 차이("유동 인구" / "유동인구")를 무시하고 비교한다.
function normalize(value) {
  return String(value ?? '').replace(/\s+/g, '').toLowerCase();
}

// 긴 키워드부터 찾고, 찾은 자리는 지워서 '메뉴판' 안의 '메뉴'가 또 걸리지 않게 한다.
export function findKeywordHits(text, categories) {
  const target = normalize(text);
  if (!target) return [];

  const terms = categories
    .flatMap((category) =>
      category.keywords.map((term) => ({ categoryId: category.id, term, needle: normalize(term) }))
    )
    .sort((a, b) => b.needle.length - a.needle.length);

  const used = new Array(target.length).fill(false);
  const hits = [];

  for (const { categoryId, term, needle } of terms) {
    let found = false;
    let at = target.indexOf(needle);
    while (at !== -1) {
      const end = at + needle.length;
      if (!used.slice(at, end).some(Boolean)) {
        used.fill(true, at, end);
        found = true;
      }
      at = target.indexOf(needle, at + 1);
    }
    if (found) hits.push({ categoryId, term });
  }
  return hits;
}

function scoreCategories(input, config, hits) {
  const answers = config.diagnosis
    .map((question, index) => ({ question, answer: input.diag?.[index] ?? null }))
    .filter(({ answer }) => answer);

  return config.categories.map((category, order) => {
    const terms = hits.filter((hit) => hit.categoryId === category.id).map((hit) => hit.term);
    const answerEvidence = answers.flatMap(({ question, answer }) => {
      const points = category.diagWeights[`${question.id}:${answer}`] ?? 0;
      return points ? [{ question: question.label, answer, points }] : [];
    });
    const keywordPoints = terms.length * category.keywordWeight;
    const answerPoints = answerEvidence.reduce((sum, item) => sum + item.points, 0);
    const industryPoints = category.industryBoost[input.industry] ?? 0;
    const evidencePoints = keywordPoints + answerPoints;

    return {
      id: category.id,
      name: category.name,
      order,
      terms,
      keywordPoints,
      answerEvidence,
      industryPoints,
      evidencePoints,
      score: evidencePoints + industryPoints,
    };
  });
}

function pickTop(scored) {
  // 업종 보정만으로는 후보가 되지 않는다. 키워드나 진단 답이 있어야 한다.
  const ranked = scored
    .filter((item) => item.evidencePoints > 0)
    .sort((a, b) => b.score - a.score || b.terms.length - a.terms.length || a.order - b.order);

  if (ranked.length > 0) return { top: ranked.slice(0, 2), isDefault: false };

  const fallback = scored.find((item) => item.id === DEFAULT_CATEGORY_ID);
  return { top: [{ ...fallback, score: 0 }], isDefault: true };
}

export function ringScore(score, isDefault = false) {
  if (isDefault) return RING_DEFAULT;
  return Math.min(RING_MAX, Math.round(RING_BASE + RING_PER_POINT * score));
}

export function classify(input, config) {
  const hits = findKeywordHits(input.text, config.categories);
  const scored = scoreCategories(input, config, hits);
  const { top, isDefault } = pickTop(scored);
  const main = config.categories.find((category) => category.id === top[0].id);

  const needsAgency =
    top.some((item) => item.id === AGENCY_CATEGORY_ID) ||
    input.diag?.[SUPPORT_QUESTION_INDEX] === UNAWARE_OF_SUPPORT;

  return {
    top,
    isDefault,
    hits,
    needsAgency,
    title: main.title,
  };
}

// 학생 팀은 2~4명. 1위 유형의 전공을 기본으로, 2위 유형의 대표 전공을 더한다.
export function matchTeam(classification, config) {
  const chosen = classification.top
    .map((item) => config.categories.find((category) => category.id === item.id))
    .filter((category) => !category.agencyOnly);

  if (chosen.length === 0) return null;

  const [main, second] = chosen;
  const counts = new Map(main.majors.map((major) => [major, 1]));
  if (second && second.majors[0]) {
    counts.set(second.majors[0], counts.get(second.majors[0]) ?? 1);
  }
  if ([...counts.values()].reduce((a, b) => a + b, 0) < 2) {
    counts.set(main.majors[0], 2);
  }

  const tasks = second
    ? [...new Set([...main.tasks.slice(0, 2), second.tasks[0]])]
    : main.tasks.slice(0, 3);

  return {
    members: [...counts].map(([major, count]) => ({ major, count })),
    size: [...counts.values()].reduce((a, b) => a + b, 0),
    tasks,
    period: main.period,
  };
}

// 기관 카드: when이 'always'면 늘, 'needsAgency'면 기관 연결이 필요할 때,
// 유형 id 목록이면 상위 유형 중 하나라도 겹칠 때 보인다.
export function recommendAgencies(classification, agencies) {
  const topIds = new Set(classification.top.map((item) => item.id));
  return agencies.filter((agency) => {
    if (agency.when === 'always') return true;
    if (agency.when === 'needsAgency') return classification.needsAgency;
    return Array.isArray(agency.when) && agency.when.some((id) => topIds.has(id));
  });
}

export function analyze(input, config, agencies) {
  const classification = classify(input, config);
  return {
    classification,
    team: matchTeam(classification, config),
    agencies: recommendAgencies(classification, agencies),
  };
}

// 저장 형식은 SPEC 3-3을 따른다. 시각·id는 호출하는 쪽에서 넣어 순수 함수로 유지한다.
export function buildSubmission(input, analysis, { id, ts, source = 'live' }) {
  return {
    id,
    ts,
    industry: input.industry,
    area: input.area,
    dong: input.dong || null,
    years: input.years || null,
    concernState: input.concernState,
    text: String(input.text ?? '').slice(0, MAX_TEXT_LENGTH),
    diag: input.diag,
    categories: analysis.classification.top.map(({ id: categoryId, score }) => ({ id: categoryId, score })),
    majors: analysis.team ? analysis.team.members.map((member) => member.major) : [],
    needsAgency: analysis.classification.needsAgency,
    source,
  };
}
