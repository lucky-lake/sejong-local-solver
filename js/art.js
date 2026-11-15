// 아이콘과 캐릭터 '고미'. 모두 직접 그린 SVG다(design/prototype-index.html의 ART와 같다).
// 체험 화면과 대시보드가 함께 쓴다.

const PATHS = {
  cup: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10h2a2.5 2.5 0 0 1 0 5h-2"/><path d="M8 3.5v2.5M12 3.5v2.5"/>',
  bowl: '<path d="M3 11h18a9 9 0 0 1-18 0z"/><path d="M8 20.5h8"/><path d="M9 7.5c0-2 2-2 2-4M14 7.5c0-2 2-2 2-4"/>',
  bag: '<path d="M5 8h14l-1.2 12.5H6.2z"/><path d="M9 10V6.5a3 3 0 0 1 6 0V10"/>',
  scissors: '<circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M8.6 8.6L20 19M8.6 15.4L20 5"/>',
  dots: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  train: '<rect x="5" y="3.5" width="14" height="14" rx="3"/><path d="M5 10.5h14M8.5 21l2-3.5M15.5 21l-2-3.5"/><circle cx="9" cy="14" r="1" fill="currentColor"/><circle cx="15" cy="14" r="1" fill="currentColor"/>',
  city: '<path d="M3 21h18M5 21V10l5-3v14M10 21V4h9v17"/><path d="M13 8h3M13 12h3M13 16h3"/>',
  tree: '<path d="M12 21v-5"/><path d="M12 16c-3.6 0-6-2.6-6-6a6 6 0 0 1 12 0c0 3.4-2.4 6-6 6z"/><path d="M4 21h16"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.7.3-1 .8-1 1.6v.4"/><path d="M12 17.2v.1"/>',
  store: '<path d="M4.5 10.5V20h15v-9.5"/><path d="M3 7l2-3.5h14L21 7v1a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z"/><path d="M10 20v-5h4v5"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2c2.8 0 5 2.2 5 5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/>',
  won: '<circle cx="12" cy="12" r="9"/><path d="M7.5 9l2 6 2.5-5 2.5 5 2-6M7 12h10"/>',
  hall: '<path d="M3 9l9-5 9 5"/><path d="M5 10v8M10 10v8M14 10v8M19 10v8M3 21h18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  up: '<path d="M12 20V5M6 11l6-6 6 6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  spark: '<path d="M12 2.5c.9 4.6 2.6 6.4 7.5 7.5-4.9 1.1-6.6 2.9-7.5 7.5-.9-4.6-2.6-6.4-7.5-7.5 4.9-1.1 6.6-2.9 7.5-7.5z" fill="currentColor" stroke="none"/>',
};

export function icon(name, size = 24, cls = '') {
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}

const INK = '#22252B';

// 구름 캐릭터 '고미'. mood: happy | worry | think | wow
export function gomi(mood = 'happy', size = 120) {
  const shapes = (attrs) =>
    `<circle cx="40" cy="54" r="24" ${attrs}/><circle cx="64" cy="40" r="28" ${attrs}/><circle cx="89" cy="56" r="21" ${attrs}/><rect x="22" y="52" width="86" height="28" rx="14" ${attrs}/>`;
  const eyes = mood === 'happy' || mood === 'wow'
    ? `<path d="M50 60q5-6 10 0M70 60q5-6 10 0" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>`
    : `<circle cx="55" cy="59" r="4" fill="${INK}"/><circle cx="75" cy="59" r="4" fill="${INK}"/>`;
  const mouth = {
    happy: `<path d="M59 67q6 6 12 0" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`,
    wow: `<path d="M58 66q7 9 14 0z" fill="${INK}"/>`,
    worry: `<path d="M60 70q5-4 10 0" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`,
    think: `<path d="M60 69h10" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`,
  }[mood];
  let extra = '';
  if (mood === 'worry') {
    extra = `<path d="M101 26c4 6 5 9 2 11.5-2.6 2-6-.5-5.3-3.6.5-2.4 2-4.6 3.3-7.9z" fill="#8CC8FF" stroke="${INK}" stroke-width="2"/><path d="M50 51l8 2M80 51l-8 2" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`;
  } else if (mood === 'think') {
    extra = `<circle cx="104" cy="28" r="4" fill="${INK}"/><circle cx="114" cy="18" r="3" fill="${INK}"/><circle cx="96" cy="36" r="2.6" fill="${INK}"/>`;
  } else {
    extra = `<path d="M108 14c.6 3 1.7 4.2 4.8 4.8-3.1.6-4.2 1.8-4.8 4.8-.6-3-1.7-4.2-4.8-4.8 3.1-.6 4.2-1.8 4.8-4.8z" fill="#FFC93C" stroke="${INK}" stroke-width="1.5"/><path d="M14 22c.5 2.4 1.4 3.3 3.8 3.8-2.4.5-3.3 1.4-3.8 3.8-.5-2.4-1.4-3.3-3.8-3.8 2.4-.5 3.3-1.4 3.8-3.8z" fill="#7FD8D0" stroke="${INK}" stroke-width="1.5"/>`;
  }
  return `<svg class="gomi" width="${size}" height="${Math.round(size * 0.8)}" viewBox="0 0 130 104" aria-hidden="true">`
    + `<g>${shapes(`fill="${INK}" stroke="${INK}" stroke-width="7"`)}</g>`
    + `<g>${shapes('fill="#FFFFFF"')}</g>`
    + `<ellipse cx="46" cy="67" rx="5.5" ry="3.4" fill="#FFB8A6"/><ellipse cx="84" cy="67" rx="5.5" ry="3.4" fill="#FFB8A6"/>`
    + eyes + mouth + extra + '</svg>';
}
