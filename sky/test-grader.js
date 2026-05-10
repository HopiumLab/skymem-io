/**
 * Unit-test the enhanced grader fast-path.
 *
 * Smoke-tests the four classes of fast-path match:
 *   1. Exact normalised match (case + punct insensitive)
 *   2. Set-containment for comma-separated list answers
 *   3. Length-ratio-bounded substring containment
 *   4. Number-word equivalence with hyphen handling
 *
 * Run via: node sky/test-grader.js
 * Exit code 0 if all 12 cases pass, 1 otherwise.
 */

const _norm = (s) => (s == null ? '' : String(s))
  .toLowerCase()
  .replace(/^[\s"'`.,;:!?]+|[\s"'`.,;:!?]+$/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const numberWords = {
  'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
  'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10',
  'eleven': '11', 'twelve': '12', 'thirteen': '13', 'fourteen': '14',
  'fifteen': '15', 'sixteen': '16', 'seventeen': '17', 'eighteen': '18',
  'nineteen': '19', 'twenty': '20', 'thirty': '30', 'forty': '40',
  'fifty': '50', 'sixty': '60', 'seventy': '70', 'eighty': '80', 'ninety': '90',
};
const wordsToNumbers = (s) => {
  let r = s;
  for (const [w, n] of Object.entries(numberWords)) {
    r = r.replace(new RegExp(`\\b${w}\\b`, 'g'), n);
  }
  r = r.replace(/\b([2-9])0[\s-]([1-9])\b/g, (_, t, u) => String(parseInt(t, 10) * 10 + parseInt(u, 10)));
  return r.replace(/(\d+)(?:st|nd|rd|th)\b/g, '$1');
};

function fastPath(expected, predicted) {
  const expN = _norm(expected);
  const predN = _norm(predicted);

  if (expN && predN && expN === predN) return 'exact';

  if (expN && expN.includes(',')) {
    const expTokens = expN.split(/[,;\/]+|\s+and\s+/).map(t => t.trim()).filter(t => t.length >= 2);
    if (expTokens.length >= 2) {
      const allPresent = expTokens.every(tok => predN.includes(tok));
      if (allPresent) return 'set-containment';
      return null; // partial list, send to judge
    }
  }

  if (expN && predN && expN.length >= 5 && predN.length >= 5) {
    const minLen = Math.min(expN.length, predN.length);
    const maxLen = Math.max(expN.length, predN.length);
    if (maxLen / minLen <= 2.0) {
      if (predN.includes(expN) || expN.includes(predN)) return 'substring';
    }
  }

  const expW = wordsToNumbers(expN);
  const predW = wordsToNumbers(predN);
  if (expW !== expN || predW !== predN) {
    if (expW === predW || (expW.length >= 3 && predW.includes(expW))) return 'number-word';
  }
  return null;
}

const cases = [
  { exp: "Running, pottery", pred: "Running, painting, pottery", want: true, label: "set-containment (more complete)" },
  { exp: "art and self-expression", pred: "Art and self-expression", want: true, label: "case" },
  { exp: "28", pred: "twenty-eight", want: true, label: "number-word hyphenated" },
  { exp: "May 7, 2023", pred: "7 May 2023", want: false, label: "different format → judge" },
  { exp: "Sweden", pred: "No information available", want: false, label: "missing → wrong" },
  { exp: "figurines, shoes", pred: "shoes", want: false, label: "partial list → wrong (no fall-through)" },
  { exp: "figurines, shoes", pred: "figurines, shoes, hats", want: true, label: "set-containment with extra" },
  { exp: "Pride parade, transgender conference", pred: "pride parade, transgender conference, charity race", want: true, label: "set-containment longer" },
  { exp: "blue", pred: "BLUE", want: true, label: "exact 4 chars" },
  { exp: "She loves to paint", pred: "loves to paint", want: true, label: "substring similar length" },
  { exp: "shoes", pred: "Some shoes from the trip", want: false, label: "substring length ratio fails (5 vs 24)" },
  { exp: "twenty", pred: "20", want: true, label: "single number-word" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = fastPath(c.exp, c.pred);
  const got = r !== null;
  const ok = got === c.want;
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${c.label}  exp="${c.exp}"  pred="${c.pred}"  → ${r || 'miss'} (want=${c.want})`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} cases pass`);
process.exit(fail === 0 ? 0 : 1);
