// `$…$` / `$$…$$` → MathML. Safari paints MathML, so the PWA does not
// need KaTeX fonts or a CDN. The TeX subset is the usual note-taking
// core; anything else stays visible as the original source.

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
  nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
  upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ',
  Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

const OPS = {
  cdot: '⋅', times: '×', div: '÷', pm: '±', mp: '∓',
  leq: '≤', geq: '≥', neq: '≠', approx: '≈', sim: '∼',
  infty: '∞', to: '→', rightarrow: '→', leftarrow: '←',
  leftrightarrow: '↔', Rightarrow: '⇒', cdots: '⋯', ldots: '…',
  subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  in: '∈', notin: '∉', forall: '∀', exists: '∃',
  cap: '∩', cup: '∪', land: '∧', lor: '∨', neg: '¬',
  partial: '∂', nabla: '∇', hbar: 'ℏ', ell: 'ℓ',
};

const FNS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'det', 'sup', 'inf']);
const BIG = { sum: '∑', int: '∫', prod: '∏', oint: '∮' };

function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function tag(name, attrs, inner) {
  const bits = [];
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    bits.push(` ${key}="${escapeText(value === true ? '' : value)}"`);
  }
  if (inner === undefined) return `<${name}${bits.join('')}/>`;
  return `<${name}${bits.join('')}>${inner}</${name}>`;
}

function mi(text) { return tag('mi', {}, escapeText(text)); }
function mn(text) { return tag('mn', {}, escapeText(text)); }
function mo(text) { return tag('mo', {}, escapeText(text)); }
function mtext(text) { return tag('mtext', {}, escapeText(text)); }
function mrow(inner) { return tag('mrow', {}, inner); }

function wrap(nodes) {
  if (!nodes.length) return tag('mrow', {}, '');
  if (nodes.length === 1) return nodes[0];
  return mrow(nodes.join(''));
}

function skipSpace(src, i) {
  while (i < src.length && /[ \t]/.test(src[i])) i += 1;
  return i;
}

function readGroup(src, i) {
  i = skipSpace(src, i);
  if (src[i] !== '{') return null;
  let depth = 1;
  let j = i + 1;
  while (j < src.length && depth) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') depth -= 1;
    j += 1;
  }
  if (depth) return null;
  return { inner: src.slice(i + 1, j - 1), next: j };
}

function readCommand(src, i) {
  if (src[i] !== '\\') return null;
  if (i + 1 >= src.length) return null;
  if (!/[A-Za-z]/.test(src[i + 1])) return { name: src[i + 1], next: i + 2 };
  let j = i + 1;
  while (j < src.length && /[A-Za-z]/.test(src[j])) j += 1;
  return { name: src.slice(i + 1, j), next: j };
}

function parseAtoms(src, i, stop) {
  const nodes = [];
  let guard = 0;
  while (i < src.length && guard < src.length + 8) {
    guard += 1;
    if (stop && stop(src, i)) break;
    i = skipSpace(src, i);
    if (i >= src.length) break;
    if (src[i] === '}') break;
    if (src[i] === '&') { i += 1; continue; }
    if (src[i] === '^' || src[i] === '_') {
      if (!nodes.length) nodes.push(mrow(''));
      const kind = src[i];
      const script = readScript(src, i + 1);
      if (!script) return { ok: false, next: i };
      const base = nodes.pop();
      nodes.push(tag(kind === '^' ? 'msup' : 'msub', {}, base + script.node));
      i = script.next;
      continue;
    }
    const atom = readAtom(src, i);
    if (!atom) return { ok: false, next: i };
    if (atom.space) {
      i = atom.next;
      continue;
    }
    let next = atom.next;
    let node = atom.node;
    while (src[next] === '^' || src[next] === '_') {
      const kind = src[next];
      const script = readScript(src, next + 1);
      if (!script) return { ok: false, next };
      if (src[script.next] === (kind === '^' ? '_' : '^') && src[next] !== src[script.next]) {
        const other = readScript(src, script.next + 1);
        if (other) {
          node = tag('msubsup', {}, node + (kind === '_' ? script.node + other.node : other.node + script.node));
          next = other.next;
          continue;
        }
      }
      node = tag(kind === '^' ? 'msup' : 'msub', {}, node + script.node);
      next = script.next;
    }
    nodes.push(node);
    i = next;
  }
  return { ok: true, node: wrap(nodes), nodes, next: i };
}

function readArg(src, i) {
  const group = readGroup(src, i);
  if (group) {
    const inner = parseAtoms(group.inner, 0);
    if (!inner.ok) return null;
    return { node: inner.node, next: group.next };
  }
  return readScript(src, i);
}

function readScript(src, i) {
  i = skipSpace(src, i);
  const group = readGroup(src, i);
  if (group) {
    const inner = parseAtoms(group.inner, 0);
    if (!inner.ok) return null;
    return { node: inner.node, next: group.next };
  }
  const atom = readAtom(src, i);
  if (!atom || atom.space) return null;
  return { node: atom.node, next: atom.next };
}

function readAtom(src, i) {
  i = skipSpace(src, i);
  if (i >= src.length) return null;
  if (src[i] === '{') {
    const group = readGroup(src, i);
    if (!group) return null;
    const inner = parseAtoms(group.inner, 0);
    if (!inner.ok) return null;
    return { node: inner.node, next: group.next };
  }
  if (src[i] === '(' || src[i] === ')' || src[i] === '[' || src[i] === ']' || src[i] === '|') {
    return { node: mo(src[i]), next: i + 1 };
  }
  if (src[i] === '+' || src[i] === '-' || src[i] === '=' || src[i] === '*' || src[i] === '/' || src[i] === '<' || src[i] === '>' || src[i] === ',') {
    return { node: mo(src[i] === '-' ? '−' : src[i]), next: i + 1 };
  }
  if (/\d/.test(src[i])) {
    let j = i;
    while (j < src.length && /[\d.]/.test(src[j])) j += 1;
    return { node: mn(src.slice(i, j)), next: j };
  }
  if (/[A-Za-z]/.test(src[i])) {
    return { node: mi(src[i]), next: i + 1 };
  }
  if (src[i] !== '\\') {
    if (src[i] === "'" ) return { node: mo('′'), next: i + 1 };
    return { node: mo(src[i]), next: i + 1 };
  }
  const cmd = readCommand(src, i);
  if (!cmd) return null;
  if (cmd.name === ' ' || cmd.name === ',' || cmd.name === ';' || cmd.name === 'quad' || cmd.name === 'qquad') {
    return { node: tag('mspace', { width: cmd.name === 'qquad' ? '2em' : cmd.name === 'quad' ? '1em' : '0.3em' }), next: cmd.next, space: true };
  }
  if (cmd.name === 'left' || cmd.name === 'right') {
    const d = skipSpace(src, cmd.next);
    const delim = src[d] === '.' ? '' : src[d] || '';
    return { node: delim ? mo(delim) : '', next: d + (src[d] ? 1 : 0) };
  }
  if (cmd.name === 'frac') {
      const a = readArg(src, cmd.next);
      const b = a ? readArg(src, a.next) : null;
    if (!a || !b) return null;
    return { node: tag('mfrac', {}, a.node + b.node), next: b.next };
  }
  if (cmd.name === 'sqrt') {
    let next = skipSpace(src, cmd.next);
    let index = null;
    if (src[next] === '[') {
      const close = src.indexOf(']', next + 1);
      if (close === -1) return null;
      const inner = parseAtoms(src.slice(next + 1, close), 0);
      if (!inner.ok) return null;
      index = inner.node;
      next = close + 1;
    }
    const group = readGroup(src, next) || readScript(src, next);
    if (!group) return null;
    const body = group.inner !== undefined ? parseAtoms(group.inner, 0) : { ok: true, node: group.node };
    if (!body.ok) return null;
    if (index) return { node: tag('mroot', {}, body.node + index), next: group.next };
    return { node: tag('msqrt', {}, body.node), next: group.next };
  }
  if (cmd.name === 'text' || cmd.name === 'mathrm' || cmd.name === 'mathbf' || cmd.name === 'mathit') {
    const group = readGroup(src, cmd.next);
    if (!group) return null;
    const node = cmd.name === 'text'
      ? mtext(group.inner)
      : tag('mi', { mathvariant: cmd.name === 'mathbf' ? 'bold' : cmd.name === 'mathrm' ? 'normal' : 'italic' }, escapeText(group.inner));
    return { node, next: group.next };
  }
  if (cmd.name === 'overline' || cmd.name === 'underline' || cmd.name === 'hat' || cmd.name === 'bar') {
    const group = readGroup(src, cmd.next) || readScript(src, cmd.next);
    if (!group) return null;
    const body = group.inner !== undefined ? parseAtoms(group.inner, 0) : { ok: true, node: group.node };
    if (!body.ok) return null;
    const name = cmd.name === 'underline' ? 'munder' : 'mover';
    const accent = cmd.name === 'hat' ? '^' : cmd.name === 'bar' || cmd.name === 'overline' ? '¯' : '_';
    return { node: tag(name, {}, body.node + mo(accent)), next: group.next };
  }
  if (GREEK[cmd.name]) return { node: mi(GREEK[cmd.name]), next: cmd.next };
  if (OPS[cmd.name]) return { node: mo(OPS[cmd.name]), next: cmd.next };
  if (BIG[cmd.name]) return { node: mo(BIG[cmd.name]), next: cmd.next };
  if (FNS.has(cmd.name)) return { node: tag('mi', { mathvariant: 'normal' }, escapeText(cmd.name)), next: cmd.next };
  if (cmd.name === '\\') return { node: tag('mspace', { linebreak: 'newline' }), next: cmd.next, space: true };
  return { node: mi(cmd.name), next: cmd.next };
}

export function texToMathML(tex, display = false) {
  const source = String(tex ?? '').trim();
  if (!source) return '';
  const parsed = parseAtoms(source, 0);
  if (!parsed.ok) return '';
  return tag('math', { display: display ? 'block' : 'inline' }, parsed.node);
}

function escaped(text, index) {
  let n = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) n += 1;
  return n % 2 === 1;
}

function inRanges(ranges, from, to) {
  return ranges.some((range) => range.from < to && range.to > from);
}

export function findMath(text, skip = []) {
  const source = String(text ?? '');
  const found = [];
  let i = 0;
  while (i < source.length) {
    if (inRanges(skip, i, i + 1)) {
      i += 1;
      continue;
    }
    if (source.startsWith('$$', i) && !escaped(source, i)) {
      const end = source.indexOf('$$', i + 2);
      if (end !== -1 && !inRanges(skip, i, end + 2)) {
        const tex = source.slice(i + 2, end);
        if (tex.trim()) found.push({ from: i, to: end + 2, tex, display: true });
        i = end + 2;
        continue;
      }
    }
    if (source[i] === '$' && !source.startsWith('$$', i) && !escaped(source, i) && !/\d/.test(source[i + 1] || '') && !/\s/.test(source[i + 1] || '') && !/\w/.test(source[i - 1] || '')) {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\n') break;
        if (source[j] === '$' && !escaped(source, j) && !source.startsWith('$$', j) && !/\s/.test(source[j - 1] || '')) break;
        j += 1;
      }
      if (source[j] === '$' && !inRanges(skip, i, j + 1)) {
        const tex = source.slice(i + 1, j);
        if (tex.trim()) found.push({ from: i, to: j + 1, tex, display: false });
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }
  return found;
}

export function mathHTML(tex, display = false) {
  const ml = texToMathML(tex, display);
  if (ml) return ml;
  return `<span class="cm-math-raw">${escapeText(tex)}</span>`;
}
