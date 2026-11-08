// Efeitos sonoros gerados na hora com Web Audio (nenhum arquivo de áudio é baixado).
// Uso: Som.play('apito'), Som.mount(elemento) para o botão de ligar/desligar e o volume.
// O navegador só libera o áudio depois do primeiro clique ou tecla na página.

const Som = (() => {
  let ctx = null, master = null, noiseBuf = null;
  const pref = (() => { try { return JSON.parse(localStorage.getItem('som') || 'null'); } catch (e) { return null; } })() || {};
  let on = pref.on !== false;
  let vol = typeof pref.vol === 'number' ? pref.vol : 0.6;
  const save = () => { try { localStorage.setItem('som', JSON.stringify({ on, vol })); } catch (e) {} };
  const last = {};                                    // evita repetir o mesmo som em rajada

  function init() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = vol; master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }
  const unlock = () => { if (init() && ctx.state === 'suspended') ctx.resume(); };
  addEventListener('pointerdown', unlock, { capture: true });
  addEventListener('keydown', unlock, { capture: true });

  // ------------------------------------------------------------ peças básicas
  function env(g, t, a, peak, hold, r) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.setValueAtTime(peak, t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + r);
    return t + a + hold + r;
  }
  function tone(type, freq, t, dur, peak = 0.3, { a = 0.01, r = 0.08, to = null, dest = master } = {}) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    o.connect(g); g.connect(dest);
    const end = env(g, t, a, peak, Math.max(0, dur - a - r), r);
    o.start(t); o.stop(end + 0.05);
    return o;
  }
  function noise(t, dur, { type = 'bandpass', freq = 1000, q = 1, peak = 0.3, a = 0.01, r = 0.1, to = null, dest = master } = {}) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; s.loop = true;
    f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    s.connect(f); f.connect(g); g.connect(dest);
    const end = env(g, t, a, peak, Math.max(0, dur - a - r), r);
    s.start(t, Math.random()); s.stop(end + 0.05);
  }
  /** "Ahh" de muita gente: várias vozes desafinadas passando por um formante. */
  function voices(t, dur, base, { peak = 0.12, n = 9, formant = 800, slide = 1, a = 0.25, r = 0.8 } = {}) {
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'bandpass'; f.frequency.value = formant; f.Q.value = 0.9;
    f.connect(g); g.connect(master);
    const end = env(g, t, a, peak, Math.max(0, dur - a - r), r);
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain();
      o.type = 'sawtooth';
      const fr = base * (1 + (Math.random() - 0.5) * 0.18);
      o.frequency.setValueAtTime(fr, t);
      o.frequency.exponentialRampToValueAtTime(fr * slide, t + dur);
      lfo.frequency.value = 4 + Math.random() * 3; lg.gain.value = fr * 0.02;
      lfo.connect(lg); lg.connect(o.frequency);
      o.connect(f);
      o.start(t + Math.random() * 0.1); o.stop(end + 0.1); lfo.start(t); lfo.stop(end + 0.1);
    }
    return end;
  }
  function whistle(t, dur, peak = 0.22) {
    const o = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 2900;
    lfo.frequency.value = 32; lg.gain.value = 90;               // o "trinado" da bolinha do apito
    lfo.connect(lg); lg.connect(o.frequency); o.connect(g); g.connect(master);
    const end = env(g, t, 0.015, peak, Math.max(0, dur - 0.06), 0.045);
    o.start(t); lfo.start(t); o.stop(end + 0.02); lfo.stop(end + 0.02);
    noise(t, dur, { freq: 3000, q: 4, peak: peak * 0.25, a: 0.01, r: 0.04 });
    return end;
  }
  const clap = (t, peak = 0.35) => { noise(t, 0.05, { type: 'highpass', freq: 1400, q: 0.7, peak, a: 0.002, r: 0.04 }); };
  const drum = (t, peak = 0.5) => { tone('sine', 140, t, 0.22, peak, { a: 0.003, r: 0.18, to: 55 }); noise(t, 0.06, { type: 'lowpass', freq: 600, peak: peak * 0.4, a: 0.002, r: 0.05 }); };
  const bell = (t, f, peak = 0.18, dur = 0.9) => { tone('sine', f, t, dur, peak, { a: 0.002, r: dur * 0.9 }); tone('sine', f * 2.76, t, dur * 0.5, peak * 0.3, { a: 0.002, r: dur * 0.45 }); };
  const crowdBed = (t, dur, peak = 0.08) => noise(t, dur, { type: 'bandpass', freq: 900, q: 0.5, peak, a: 0.3, r: 0.6 });

  // ------------------------------------------------------------ catálogo
  const SOUNDS = {
    /** Início de jogo: um apito longo. */
    apito(t) { whistle(t, 0.75); },
    /** Intervalo: dois apitos. */
    intervalo(t) { whistle(t, 0.3); whistle(t + 0.42, 0.55); },
    /** Fim de jogo: três apitos, o último longo. */
    fim(t) { whistle(t, 0.25); whistle(t + 0.36, 0.25); whistle(t + 0.72, 0.9); },
    /** Gol do seu time: explosão da torcida + corneta. */
    gol(t) {
      noise(t, 3.2, { type: 'bandpass', freq: 700, q: 0.4, peak: 0.32, a: 0.08, r: 1.6, to: 1100 });
      voices(t + 0.05, 3, 260, { peak: 0.16, n: 12, formant: 900, slide: 1.12, a: 0.12, r: 1.4 });
      for (let i = 0; i < 3; i++) { tone('sawtooth', 440, t + 0.35 + i * 0.32, 0.24, 0.07, { a: 0.01, r: 0.05 }); tone('square', 220, t + 0.35 + i * 0.32, 0.24, 0.04, { a: 0.01, r: 0.05 }); }
      for (let i = 0; i < 18; i++) clap(t + 1.2 + i * 0.09 + Math.random() * 0.05, 0.12);
    },
    /** Gol sofrido: "óóóh" de lamento. */
    golSofrido(t) {
      voices(t, 1.9, 210, { peak: 0.13, n: 10, formant: 500, slide: 0.72, a: 0.15, r: 0.9 });
      noise(t, 1.6, { type: 'lowpass', freq: 700, q: 0.5, peak: 0.12, a: 0.1, r: 0.9, to: 300 });
    },
    /** Gol em outro jogo: um "plim" discreto. */
    golOutro(t) { bell(t, 1046, 0.08, 0.5); bell(t + 0.09, 1568, 0.06, 0.6); },
    /** Cartão amarelo: apito curto. */
    amarelo(t) { whistle(t, 0.22, 0.16); },
    /** Expulsão: apito + dois tons descendo. */
    vermelho(t) { whistle(t, 0.35, 0.18); tone('square', 520, t + 0.4, 0.18, 0.08); tone('square', 390, t + 0.6, 0.3, 0.08); },
    /** Lesão: pancada surda e um gemido da torcida. */
    lesao(t) { drum(t, 0.4); voices(t + 0.1, 0.9, 190, { peak: 0.06, n: 6, formant: 500, slide: 0.85, a: 0.1, r: 0.5 }); },
    /** Mosaico / apoio: batucada com palmas e canto. */
    canto(t) {
      crowdBed(t, 3.4, 0.07);
      const beat = 0.24;
      [0, 2, 4, 5, 6, 8, 10, 12, 13, 14].forEach((k) => drum(t + k * beat, 0.32));
      [1, 3, 4.5, 5.5, 7, 9, 11, 12.5, 13.5].forEach((k) => clap(t + k * beat, 0.22));
      voices(t, 1.4, 300, { peak: 0.07, n: 8, formant: 950, a: 0.1, r: 0.3 });
      voices(t + 1.9, 1.4, 340, { peak: 0.07, n: 8, formant: 950, a: 0.1, r: 0.4 });
    },
    /** Aplausos. */
    aplausos(t) { crowdBed(t, 2.4, 0.05); for (let i = 0; i < 60; i++) clap(t + Math.random() * 2.2, 0.06 + Math.random() * 0.08); },
    /** Vaia: "uuuu" grave e longo. */
    vaia(t) {
      voices(t, 2.4, 125, { peak: 0.14, n: 12, formant: 380, slide: 0.94, a: 0.35, r: 0.9 });
      noise(t, 2.3, { type: 'lowpass', freq: 500, q: 0.4, peak: 0.07, a: 0.3, r: 0.8 });
    },
    /** Invasão ao CT: sirene e tumulto. */
    sirene(t) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.connect(g); g.connect(master);
      for (let i = 0; i < 3; i++) { o.frequency.setValueAtTime(650, t + i * 0.8); o.frequency.linearRampToValueAtTime(1150, t + i * 0.8 + 0.4); o.frequency.linearRampToValueAtTime(650, t + i * 0.8 + 0.8); }
      const end = env(g, t, 0.05, 0.12, 2.2, 0.2); o.start(t); o.stop(end + 0.05);
      noise(t, 2.5, { type: 'bandpass', freq: 600, q: 0.6, peak: 0.08, a: 0.2, r: 0.5 });
    },
    /** Negócio fechado: caixa registradora. */
    dinheiro(t) { noise(t, 0.05, { type: 'highpass', freq: 3000, peak: 0.25, a: 0.002, r: 0.04 }); tone('square', 180, t, 0.06, 0.08, { a: 0.002, r: 0.04 }); bell(t + 0.08, 2637, 0.14, 1.1); bell(t + 0.08, 3951, 0.09, 1.1); },
    /** Proposta recusada ou expirada. */
    recusa(t) { tone('triangle', 392, t, 0.16, 0.14); tone('triangle', 294, t + 0.17, 0.3, 0.14); },
    /** Nova mensagem. */
    mensagem(t) { bell(t, 880, 0.09, 0.4); bell(t + 0.12, 1318, 0.08, 0.6); },
    /** Obra iniciada: três marteladas. */
    obra(t) { for (let i = 0; i < 3; i++) { noise(t + i * 0.22, 0.05, { freq: 2200, q: 2, peak: 0.3, a: 0.002, r: 0.04 }); tone('sine', 190, t + i * 0.22, 0.09, 0.25, { a: 0.002, r: 0.07, to: 120 }); } },
    /** Jovem promovido / conquista. */
    conquista(t) { [523, 659, 784, 1046].forEach((f, i) => bell(t + i * 0.1, f, 0.1, 0.7)); },
    /** Pronto para a rodada. */
    pronto(t) { whistle(t, 0.14, 0.12); },
    /** Clique leve (botões de ação). */
    clique(t) { tone('sine', 1200, t, 0.03, 0.05, { a: 0.002, r: 0.025 }); },
  };

  function play(name, { delay = 0, gap = 0.25 } = {}) {
    if (!on || !SOUNDS[name]) return;
    if (!init()) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (ctx.state !== 'running' && ctx.state !== 'suspended') return;
    const now = performance.now();
    if (last[name] && now - last[name] < gap * 1000) return;
    last[name] = now;
    try { SOUNDS[name](ctx.currentTime + 0.02 + delay); } catch (e) { /* áudio indisponível: segue sem som */ }
  }

  // ------------------------------------------------------------ controle na tela
  const ICON_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
  const ICON_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>';
  function mount(el) {
    el.className = 'sound';
    const render = () => {
      el.innerHTML = `<button type="button" class="sound-btn" aria-pressed="${on}" title="${on ? 'Desligar sons' : 'Ligar sons'}">${on ? ICON_ON : ICON_OFF}<span>${on ? 'Som' : 'Mudo'}</span></button>
        <input type="range" min="0" max="100" step="5" value="${Math.round(vol * 100)}" aria-label="Volume" ${on ? '' : 'disabled'}>`;
    };
    render();
    el.addEventListener('click', (e) => {
      if (!e.target.closest('.sound-btn')) return;
      on = !on; save(); render();
      if (on) play('pronto');
    });
    el.addEventListener('input', (e) => {
      if (e.target.type !== 'range') return;
      vol = Number(e.target.value) / 100; save();
      if (master) master.gain.value = vol;
    });
    el.addEventListener('change', (e) => { if (e.target.type === 'range') play('mensagem', { gap: 0 }); });
  }

  return { play, mount, get on() { return on; }, list: () => Object.keys(SOUNDS) };
})();
