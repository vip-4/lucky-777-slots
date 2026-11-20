/* ==========================================================================
 * 幸運 777 老虎機 — 遊戲核心
 * --------------------------------------------------------------------------
 * 設計要點：
 *  1. 有限狀態機（FSM）：IDLE → SPINNING → STOPPING → EVALUATING → IDLE
 *  2. 純 Canvas 2D 渲染，無外部圖片／字型／套件，可直接靜態託管
 *  3. 物件池管理粒子，避免 GC 造成掉幀
 *  4. Web Audio API 音效，首次使用者手勢才解鎖（iOS Safari 限制）
 *  5. Page Visibility API 在分頁隱藏時暫停 RAF，節省電量
 *  6. 所有開獎邏輯僅供「演示」，正式博弈請改由伺服器端 RNG 決定
 * ========================================================================== */
(function () {
  'use strict';

  /* ----------------------------------------------------------------------
   * 常數與設定
   * -------------------------------------------------------------------- */
  const LOGICAL_W = 600;            // 邏輯畫布寬（3 軸 × 200）
  const LOGICAL_H = 240;            // 邏輯畫布高（3 列 × 80）
  const REEL_COUNT = 3;
  const CELL_H = LOGICAL_H / 3;     // 每格高度 = 80
  const REEL_W = LOGICAL_W / REEL_COUNT;

  // 符號表：weight 總和 = 100，方便計算權重
  const SYMBOLS = [
    { id: 'seven',   glyph: '7', color: '#ff4d6d', weight: 6  },
    { id: 'diamond', glyph: '◆', color: '#7dd3fc', weight: 10 },
    { id: 'star',    glyph: '★', color: '#ffcc4d', weight: 14 },
    { id: 'bell',    glyph: '♬', color: '#a78bfa', weight: 18 },
    { id: 'cherry',  glyph: '●', color: '#34d399', weight: 24 },
    { id: 'clover',  glyph: '♣', color: '#fb923c', weight: 28 }
  ];
  const N = SYMBOLS.length;

  // 賠率表（倍數）：與頁面上的 HTML 表格保持一致
  const PAYTABLE = [
    { key: 'seven3',   mult: 100, label: '三個 7' },
    { key: 'diamond3', mult: 50,  label: '三個鑽石' },
    { key: 'star3',    mult: 25,  label: '三顆星星' },
    { key: 'bell3',    mult: 12,  label: '三個鈴鐺' },
    { key: 'cherry3',  mult: 8,   label: '三顆櫻桃' },
    { key: 'seven2',   mult: 5,   label: '任意兩個 7' },
    { key: 'cherry2',  mult: 3,   label: '任意兩顆櫻桃' }
  ];

  const STATE = Object.freeze({
    IDLE: 'IDLE',
    SPINNING: 'SPINNING',
    STOPPING: 'STOPPING',
    EVALUATING: 'EVALUATING'
  });

  const STORAGE = { credits: 'l777.credits', best: 'l777.best' };
  const START_CREDITS = 1000;

  /* ----------------------------------------------------------------------
   * DOM 參照
   * -------------------------------------------------------------------- */
  const canvas    = document.getElementById('slot-canvas');
  const ctx       = canvas.getContext('2d', { alpha: false });
  const statusEl  = document.getElementById('game-status');
  const resultEl  = document.getElementById('result-line');
  const creditsEl = document.getElementById('stat-credits');
  const betEl     = document.getElementById('stat-bet');
  const lastEl    = document.getElementById('stat-last');
  const bestEl    = document.getElementById('stat-best');
  const spinBtn   = document.getElementById('spin-btn');
  const autoBtn   = document.getElementById('auto-btn');
  const soundBtn  = document.getElementById('sound-btn');
  const resetBtn  = document.getElementById('reset-btn');
  const betInputs = Array.from(document.querySelectorAll('input[name="bet"]'));

  /* ----------------------------------------------------------------------
   * 執行環境旗標
   * -------------------------------------------------------------------- */
  const reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let dpr = 1;
  let rafId = 0;
  let lastFrame = 0;
  let state = STATE.IDLE;

  let credits = readStorage(STORAGE.credits, START_CREDITS);
  let bestWin = readStorage(STORAGE.best, 0);
  let bet = 10;
  let lastWin = 0;
  let autoSpin = false;
  let autoTimer = 0;
  let soundOn = true;
  let audioCtx = null;

  let shake = 0;          // 螢幕震動強度
  let winGlow = 0;        // 中獎高亮剩餘時間（ms）
  let winLabel = '';      // 中獎名稱

  // 轉軸狀態：pos 為「中間列」對應的連續符號索引
  const reels = Array.from({ length: REEL_COUNT }, function (_, i) {
    return { pos: i, spinning: false, tween: null, stopAt: 0, result: 0, blur: 0 };
  });
  let results = [0, 0, 0];

  /* ----------------------------------------------------------------------
   * 粒子物件池：預設配置 160 個，重複使用避免頻繁 new
   * -------------------------------------------------------------------- */
  const PARTICLE_MAX = 160;
  const particles = Array.from({ length: PARTICLE_MAX }, function () {
    return { active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 4, color: '#ffcc4d', spin: 0, rot: 0 };
  });

  /* ======================================================================
   * 工具函式
   * ==================================================================== */

  function readStorage(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return fallback;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
    } catch (e) {
      // Safari 無痕模式會拋出例外，直接退回預設值
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try { window.localStorage.setItem(key, String(value)); } catch (e) { /* 忽略 */ }
  }

  function formatNumber(n) { return Math.floor(n).toLocaleString('zh-Hant'); }

  // 加權隨機：演示用。正式環境請改為伺服器端 CSPRNG。
  function weightedPick() {
    let r = Math.random() * 100;
    for (let i = 0; i < N; i += 1) {
      r -= SYMBOLS[i].weight;
      if (r < 0) return i;
    }
    return N - 1;
  }

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function modulo(value, m) { return ((value % m) + m) % m; }

  /* ======================================================================
   * 音效（Web Audio API）
   * ==================================================================== */

  function ensureAudio() {
    if (!soundOn) return null;
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (e) { return null; }
  }

  function beep(freq, duration, type, volume, delay) {
    const ac = ensureAudio();
    if (!ac) return;
    const t0 = ac.currentTime + (delay || 0);
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(volume || 0.06, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function playStopSound(index) { beep(420 + index * 90, 0.09, 'triangle', 0.05, 0); }
  function playWinSound() {
    [523, 659, 784, 1047].forEach(function (f, i) {
      beep(f, 0.22, 'sine', 0.07, i * 0.08);
    });
  }

  /* ======================================================================
   * 畫布設定（高 DPI 校正，上限 2 以兼顧效能）
   * ==================================================================== */

  function setupCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(LOGICAL_W * dpr);
    canvas.height = Math.round(LOGICAL_H * dpr);
    ctx.imageSmoothingEnabled = true;
  }

  /* ======================================================================
   * 狀態機
   * ==================================================================== */

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function updateHud() {
    creditsEl.textContent = formatNumber(credits);
    betEl.textContent = formatNumber(bet);
    lastEl.textContent = formatNumber(lastWin);
    bestEl.textContent = formatNumber(bestWin);
  }

  function spin() {
    if (state !== STATE.IDLE || credits < bet) {
      if (credits < bet && state === STATE.IDLE) {
        resultEl.textContent = '代幣不足，請按「重置」重新開始。';
        setStatus('代幣不足');
      }
      return;
    }

    ensureAudio(); // 於使用者手勢中解鎖音訊（iOS Safari 必要）
    stopAutoSpin();
    startLoop();   // 若先前因 IntersectionObserver 暫停，這裡恢復渲染

    credits -= bet;
    lastWin = 0;
    winGlow = 0;
    winLabel = '';
    state = STATE.SPINNING;
    setStatus('旋轉中…');
    resultEl.textContent = '轉輪正在旋轉…';
    spinBtn.disabled = true;
    updateHud();

    const now = performance.now();
    const baseDelay = reduceMotion ? 180 : 520;

    for (let i = 0; i < REEL_COUNT; i += 1) {
      const reel = reels[i];
      reel.spinning = true;
      reel.tween = null;
      reel.blur = reduceMotion ? 0 : 6;
      reel.stopAt = now + baseDelay + i * (reduceMotion ? 160 : 420);
      reel.result = weightedPick();
    }
    results = reels.map(function (r) { return r.result; });

    beep(180, 0.07, 'square', 0.04, 0);
  }

  function startStopTween(reel, index) {
    const from = reel.pos;
    const rotations = 4 + index;
    // 計算一個大於目前位置、且 lands 在 result 上的整數目標
    const target = reel.result +
      (Math.floor((from - reel.result) / N) + rotations + 1) * N;
    reel.tween = {
      from: from,
      to: target,
      elapsed: 0,
      duration: reduceMotion ? 180 : 480 + index * 70
    };
    state = STATE.STOPPING;
    setStatus('轉輪停止中…');
  }

  function evaluate() {
    state = STATE.EVALUATING;
    setStatus('結算中');

    // 將位置正規化到 0..N-1，避免長時間遊玩後浮點數過大
    reels.forEach(function (reel) { reel.pos = modulo(reel.pos, N); });

    const ids = results.map(function (idx) { return SYMBOLS[idx].id; });
    let payout = 0;
    let label = '';

    if (ids[0] === 'seven' && ids[1] === 'seven' && ids[2] === 'seven') {
      payout = 100; label = '三個 7 · 大獎！';
    } else if (ids[0] === 'diamond' && ids[1] === 'diamond' && ids[2] === 'diamond') {
      payout = 50; label = '三個鑽石';
    } else if (ids[0] === 'star' && ids[1] === 'star' && ids[2] === 'star') {
      payout = 25; label = '三顆星星';
    } else if (ids[0] === 'bell' && ids[1] === 'bell' && ids[2] === 'bell') {
      payout = 12; label = '三個鈴鐺';
    } else if (ids[0] === 'cherry' && ids[1] === 'cherry' && ids[2] === 'cherry') {
      payout = 8; label = '三顆櫻桃';
    } else {
      const sevenCount = ids.filter(function (id) { return id === 'seven'; }).length;
      const cherryCount = ids.filter(function (id) { return id === 'cherry'; }).length;
      if (sevenCount === 2) { payout = 5; label = '任意兩個 7'; }
      else if (cherryCount === 2) { payout = 3; label = '任意兩顆櫻桃'; }
    }

    const winAmount = payout * bet;
    lastWin = winAmount;

    if (winAmount > 0) {
      credits += winAmount;
      if (winAmount > bestWin) {
        bestWin = winAmount;
        writeStorage(STORAGE.best, bestWin);
      }
      winGlow = reduceMotion ? 350 : 1100;
      winLabel = label + ' +' + formatNumber(winAmount);
      shake = reduceMotion ? 0 : 8;
      spawnParticles(Math.min(60, 18 + payout));
      playWinSound();
      resultEl.textContent = '中獎！' + label + '，獲得 ' + formatNumber(winAmount) + ' 代幣。';
      setStatus('中獎');
    } else {
      resultEl.textContent = '未中獎，再試一次！';
      setStatus('未中獎');
    }

    writeStorage(STORAGE.credits, credits);
    updateHud();
    spinBtn.disabled = false;
    state = STATE.IDLE;

    if (autoSpin) {
      if (credits >= bet) {
        autoTimer = window.setTimeout(spin, 650);
      } else {
        stopAutoSpin();
        resultEl.textContent = '代幣不足，自動旋轉已停止。';
      }
    }
  }

  function stopAutoSpin() {
    autoSpin = false;
    if (autoTimer) { window.clearTimeout(autoTimer); autoTimer = 0; }
    if (autoBtn) { autoBtn.setAttribute('aria-pressed', 'false'); autoBtn.textContent = '自動旋轉'; }
  }

  /* ======================================================================
   * 粒子系統
   * ==================================================================== */

  function spawnParticles(count) {
    if (reduceMotion) return;
    let spawned = 0;
    for (let i = 0; i < PARTICLE_MAX && spawned < count; i += 1) {
      const p = particles[i];
      if (p.active) continue;
      p.active = true;
      p.x = LOGICAL_W / 2 + (Math.random() - 0.5) * REEL_W;
      p.y = LOGICAL_H / 2;
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const speed = 2.5 + Math.random() * 5.5;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.max = 700 + Math.random() * 600;
      p.life = p.max;
      p.size = 3 + Math.random() * 5;
      p.color = Math.random() > 0.45 ? '#ffcc4d' : '#fff4c2';
      p.rot = Math.random() * Math.PI;
      p.spin = (Math.random() - 0.5) * 0.3;
      spawned += 1;
    }
  }

  function updateParticles(dt) {
    for (let i = 0; i < PARTICLE_MAX; i += 1) {
      const p = particles[i];
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      p.vy += 0.00035 * dt; // 重力
      p.x += p.vx * dt * 0.06;
      p.y += p.vy * dt * 0.06;
      p.rot += p.spin * dt * 0.06;
    }
  }

  /* ======================================================================
   * 更新迴圈
   * ==================================================================== */

  function update(dt, now) {
    let stoppedCount = 0;

    for (let i = 0; i < REEL_COUNT; i += 1) {
      const reel = reels[i];
      if (!reel.spinning) { stoppedCount += 1; continue; }

      if (reel.tween) {
        const tw = reel.tween;
        tw.elapsed += dt;
        const t = Math.min(tw.elapsed / tw.duration, 1);
        const e = easeOutCubic(t);
        reel.pos = tw.from + (tw.to - tw.from) * e;
        reel.blur = reduceMotion ? 0 : (1 - e) * 5;
        if (t >= 1) {
          reel.pos = tw.to;
          reel.blur = 0;
          reel.spinning = false;
          reel.tween = null;
          playStopSound(i);
          stoppedCount += 1;
        }
      } else if (now >= reel.stopAt) {
        startStopTween(reel, i);
      } else {
        reel.pos += 0.024 * dt; // 每毫秒 0.024 格 ≈ 每秒 24 格
      }
    }

    if (state === STATE.SPINNING || state === STATE.STOPPING) {
      if (stoppedCount === REEL_COUNT) evaluate();
    }

    if (shake > 0) shake = Math.max(0, shake - dt * 0.018);
    if (winGlow > 0) winGlow = Math.max(0, winGlow - dt);
    updateParticles(dt);
  }

  /* ======================================================================
   * 繪圖
   * ==================================================================== */

  function roundRectOn(g, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
  }

  function roundRect(x, y, w, h, r) { roundRectOn(ctx, x, y, w, h, r); }

  /* ----------------------------------------------------------------------
   * 精靈圖集（借鏡 Mindustry 的 sprite packing）
   * ----------------------------------------------------------------------
   * 原本每幀要為每個符號重新建立漸層、roundRect 路徑、shadowBlur 與 fillText，
   * 在 3 軸 × 5 個可見符號下最高可達 90 次/幀，低端手機容易掉幀。
   * 這裡在初始化時把 6 種符號各畫一次到離屏 canvas，之後只做 drawImage。
   */
  const SYMBOL_SIZE = 64;
  const symbolAtlas = [];
  let reelFade = null;

  function buildSymbolAtlas() {
    symbolAtlas.length = 0;
    for (let i = 0; i < SYMBOLS.length; i += 1) {
      const sprite = document.createElement('canvas');
      sprite.width = SYMBOL_SIZE;
      sprite.height = SYMBOL_SIZE;
      const g = sprite.getContext('2d');
      const s = SYMBOLS[i];

      const grad = g.createLinearGradient(0, 0, SYMBOL_SIZE, SYMBOL_SIZE);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(1, '#e6e2d6');
      g.fillStyle = grad;
      roundRectOn(g, 1, 1, SYMBOL_SIZE - 2, SYMBOL_SIZE - 2, 10);
      g.fill();

      g.shadowColor = s.color;
      g.shadowBlur = 12;
      g.fillStyle = s.color;
      g.font = '900 46px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(s.glyph, SYMBOL_SIZE / 2, SYMBOL_SIZE / 2 + 2);
      symbolAtlas.push(sprite);
    }

    // 上下遮罩漸層只跟畫布高度有關，建立一次即可
    reelFade = ctx.createLinearGradient(0, 0, 0, LOGICAL_H);
    reelFade.addColorStop(0, 'rgba(7,11,22,0.92)');
    reelFade.addColorStop(0.32, 'rgba(7,11,22,0)');
    reelFade.addColorStop(0.68, 'rgba(7,11,22,0)');
    reelFade.addColorStop(1, 'rgba(7,11,22,0.92)');
  }

  function drawSymbol(index, cx, cy, blur) {
    const sprite = symbolAtlas[index];
    if (!sprite) return;
    const drawSize = 62;
    const half = drawSize / 2;

    // 動態模糊：直接疊印位移過的圖集影像，不再重新繪製字形
    if (blur > 0.2) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.drawImage(sprite, cx - half, cy - half + blur, drawSize, drawSize);
      ctx.drawImage(sprite, cx - half, cy - half - blur, drawSize, drawSize);
      ctx.restore();
    }
    ctx.drawImage(sprite, cx - half, cy - half, drawSize, drawSize);
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#070b16';
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

    ctx.save();
    if (shake > 0.1) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    }

    // 逐軸繪製
    for (let i = 0; i < REEL_COUNT; i += 1) {
      const reel = reels[i];
      const x0 = i * REEL_W;

      ctx.fillStyle = i % 2 === 0 ? '#0d1428' : '#0a1122';
      ctx.fillRect(x0, 0, REEL_W, LOGICAL_H);

      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, REEL_W, LOGICAL_H);
      ctx.clip();

      const base = Math.floor(reel.pos);
      for (let k = base - 2; k <= base + 2; k += 1) {
        const y = LOGICAL_H / 2 + (k - reel.pos) * CELL_H;
        if (y < -CELL_H || y > LOGICAL_H + CELL_H) continue;
        drawSymbol(modulo(k, N), x0 + REEL_W / 2, y, reel.blur);
      }

      // 上下漸層遮罩：使用預建立好的漸層，避免每軸每幀重建
      ctx.fillStyle = reelFade;
      ctx.fillRect(x0, 0, REEL_W, LOGICAL_H);
      ctx.restore();

      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, 0);
      ctx.lineTo(x0 + 0.5, LOGICAL_H);
      ctx.stroke();
    }

    // 中獎高亮框
    if (winGlow > 0) {
      const alpha = Math.min(0.85, winGlow / 600);
      ctx.strokeStyle = 'rgba(255,204,77,' + alpha + ')';
      ctx.lineWidth = 3;
      ctx.shadowColor = '#ffcc4d';
      ctx.shadowBlur = 18;
      roundRect(6, LOGICAL_H / 2 - CELL_H / 2 + 3, LOGICAL_W - 12, CELL_H - 6, 12);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // 中賠線
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = 'rgba(255,204,77,0.65)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, LOGICAL_H / 2 - CELL_H / 2);
    ctx.lineTo(LOGICAL_W, LOGICAL_H / 2 - CELL_H / 2);
    ctx.moveTo(0, LOGICAL_H / 2 + CELL_H / 2);
    ctx.lineTo(LOGICAL_W, LOGICAL_H / 2 + CELL_H / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 粒子
    for (let i = 0; i < PARTICLE_MAX; i += 1) {
      const p = particles[i];
      if (!p.active) continue;
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life / 260);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }

    // 中獎文字
    if (winGlow > 0 && winLabel) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, winGlow / 400);
      ctx.font = '900 30px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#1a1300';
      ctx.strokeText(winLabel, LOGICAL_W / 2, 34);
      ctx.fillStyle = '#ffcc4d';
      ctx.fillText(winLabel, LOGICAL_W / 2, 34);
      ctx.restore();
    }

    ctx.restore();
  }

  /* ======================================================================
   * 主迴圈（分頁隱藏時暫停）
   * ==================================================================== */

  function frame(timestamp) {
    if (!lastFrame) lastFrame = timestamp;
    const dt = Math.min(timestamp - lastFrame, 50); // 防止切回分頁時 dt 過大
    lastFrame = timestamp;
    update(dt, timestamp);
    draw();
    rafId = window.requestAnimationFrame(frame);
  }

  function startLoop() {
    if (rafId) return;
    lastFrame = 0;
    rafId = window.requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
  }

  /* ======================================================================
   * 事件綁定
   * ==================================================================== */

  spinBtn.addEventListener('click', spin);

  betInputs.forEach(function (input) {
    input.addEventListener('change', function () {
      if (!input.checked) return;
      bet = Number(input.value) || 10;
      updateHud();
    });
  });

  autoBtn.addEventListener('click', function () {
    if (autoSpin) { stopAutoSpin(); return; }
    if (credits < bet) {
      resultEl.textContent = '代幣不足，無法啟動自動旋轉。';
      return;
    }
    autoSpin = true;
    autoBtn.setAttribute('aria-pressed', 'true');
    autoBtn.textContent = '停止自動';
    setStatus('自動旋轉中');
    spin();
  });

  soundBtn.addEventListener('click', function () {
    soundOn = !soundOn;
    soundBtn.setAttribute('aria-pressed', String(soundOn));
    soundBtn.textContent = '音效：' + (soundOn ? '開' : '關');
    if (soundOn) ensureAudio();
  });

  resetBtn.addEventListener('click', function () {
    stopAutoSpin();
    credits = START_CREDITS;
    bestWin = 0;
    lastWin = 0;
    state = STATE.IDLE;
    writeStorage(STORAGE.credits, credits);
    writeStorage(STORAGE.best, bestWin);
    reels.forEach(function (reel, i) {
      reel.pos = i;
      reel.spinning = false;
      reel.tween = null;
      reel.blur = 0;
    });
    results = [0, 0, 0];
    shake = 0;
    winGlow = 0;
    winLabel = '';
    spinBtn.disabled = false;
    setStatus('準備就緒');
    resultEl.textContent = '已重置為 ' + formatNumber(credits) + ' 代幣。';
    updateHud();
  });

  // 鍵盤快捷鍵：焦點在 body 時按空白鍵或 Enter 旋轉
  document.addEventListener('keydown', function (e) {
    if (e.target !== document.body) return;
    if (e.code === 'Space' || e.key === 'Enter') {
      e.preventDefault();
      spin();
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopLoop();
      if (audioCtx && audioCtx.state === 'running') audioCtx.suspend();
    } else {
      startLoop();
      if (soundOn && audioCtx) audioCtx.resume();
    }
  });

  window.addEventListener('resize', setupCanvas, { passive: true });

  /* ======================================================================
   * 初始化
   * ==================================================================== */
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  setupCanvas();
  buildSymbolAtlas();
  updateHud();
  draw();
  startLoop();

  // 只在遊戲區進入可視範圍時才啟動渲染，降低首屏成本
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(function (entries) {
      if (entries.some(function (entry) { return entry.isIntersecting; })) {
        startLoop();
      } else if (state === STATE.IDLE) {
        stopLoop();
      }
    }, { threshold: 0.01 });
    io.observe(canvas);
  }
})();
