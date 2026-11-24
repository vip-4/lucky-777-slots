/**
 * ============================================================
 * Lucky 777 Slots — 遊戲邏輯
 * ------------------------------------------------------------
 * 設計重點：
 *  1. 有限狀態機（FSM）避免連續點擊造成競態條件
 *  2. 加權隨機數產生符號（示範用；正式平台應由伺服器 RNG 決定）
 *  3. Web Audio API 即時合成音效，並處理 iOS Safari 音訊解鎖
 *  4. Canvas 粒子特效使用物件池概念，避免頻繁配置設定
 *  5. ARIA 即時播報，支援螢幕閱讀器與鍵盤操作
 * ============================================================
 */
(function () {
  'use strict';

  /* -------------------- 常數與設定 -------------------- */

  // 符號表：weight 為出現權重（總和 100），pay3 / pay2 為賠率倍數
  var SYMBOLS = [
    { id: 'cherry',  glyph: '🍒', name: '櫻桃',   weight: 30, pay3: 3,  pay2: 1 },
    { id: 'lemon',   glyph: '🍋', name: '檸檬',   weight: 24, pay3: 5,  pay2: 1 },
    { id: 'bell',    glyph: '🔔', name: '鈴鐺',   weight: 18, pay3: 8,  pay2: 2 },
    { id: 'star',    glyph: '⭐', name: '星星',   weight: 13, pay3: 10, pay2: 2 },
    { id: 'diamond', glyph: '💎', name: '鑽石',   weight: 9,  pay3: 15, pay2: 2 },
    { id: 'seven',   glyph: '7️⃣', name: '幸運七', weight: 6,  pay3: 20, pay2: 2 }
  ];

  // 有限狀態機狀態
  var STATE = {
    IDLE: 'IDLE',           // 待機，可接受下注與旋轉
    SPINNING: 'SPINNING',   // 轉輪旋轉中
    EVALUATING: 'EVALUATING'// 結算中
  };

  var SPIN_INTERVAL = 72;      // 符號切換間隔（ms）
  var REEL_STOP_TIMES = [620, 900, 1180]; // 各軸停止時間（ms）

  /* -------------------- DOM 參考 -------------------- */

  var elReels      = document.getElementById('reels');
  var elReelList   = elReels ? Array.prototype.slice.call(elReels.querySelectorAll('.reel')) : [];
  var elBalance    = document.getElementById('balance');
  var elBet        = document.getElementById('bet');
  var elLastWin    = document.getElementById('lastWin');
  var elStatus     = document.getElementById('gameStatus');
  var elSpinBtn    = document.getElementById('spinBtn');
  var elBetBtns    = Array.prototype.slice.call(document.querySelectorAll('.bet-btn'));
  var elMachine    = document.querySelector('.machine-shell');
  var elCanvas     = document.getElementById('fxCanvas');

  // 若必備元素不存在直接結束，避免其他區塊腳本錯誤
  if (!elSpinBtn || elReelList.length !== 3) return;

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* -------------------- 遊戲狀態 -------------------- */

  var game = {
    state: STATE.IDLE,
    balance: 1000,
    bet: 10,
    lastWin: 0,
    current: [SYMBOLS[0], SYMBOLS[5], SYMBOLS[2]],
    timers: []
  };

  /* ============================================================
     音效模組：Web Audio API
     ============================================================ */

  var AudioKit = (function () {
    var ctx = null;
    var unlocked = false;

    /** 首次使用者互動時解鎖 AudioContext（iOS Safari 必要） */
    function unlock() {
      if (unlocked) return;
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        ctx = new Ctx();
        if (ctx.state === 'suspended') ctx.resume();
        unlocked = true;
      } catch (err) {
        // 不支援音訊時靜默降級
        ctx = null;
      }
    }

    /** 播放單音 */
    function tone(freq, duration, type, volume, delay) {
      if (!ctx || ctx.state !== 'running') return;
      var startAt = ctx.currentTime + (delay || 0);
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(volume || 0.08, startAt + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.02);
    }

    return {
      unlock: unlock,
      spin: function () {
        tone(180, 0.12, 'triangle', 0.06, 0);
        tone(240, 0.10, 'triangle', 0.05, 0.08);
      },
      stop: function () {
        tone(420, 0.06, 'square', 0.035, 0);
      },
      win: function (level) {
        var notes = [523.25, 659.25, 783.99, 1046.5];
        var count = level === 'big' ? 4 : 3;
        for (var i = 0; i < count; i++) {
          tone(notes[i], 0.22, 'sine', 0.075, i * 0.09);
        }
      },
      lose: function () {
        tone(160, 0.16, 'sine', 0.035, 0);
      }
    };
  })();

  /* ============================================================
     特效模組：Canvas 金幣粒子（輕量物件池）
     ============================================================ */

  var Fx = (function () {
    var ctx = elCanvas ? elCanvas.getContext('2d') : null;
    var particles = [];
    var rafId = null;
    var MAX_PARTICLES = 70;
    var colors = ['#f5c451', '#ffe6a3', '#c8912b', '#ffffff'];

    // 預先配置粒子物件，避免動畫中頻繁 GC
    for (var i = 0; i < MAX_PARTICLES; i++) {
      particles.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, size: 0, life: 0, maxLife: 0, color: '#fff', spin: 0, angle: 0 });
    }

    function resize() {
      if (!elCanvas || !elMachine) return;
      var rect = elMachine.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      elCanvas.width = Math.round(rect.width * dpr);
      elCanvas.height = Math.round(rect.height * dpr);
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function burst() {
      if (!ctx || reduceMotion) return;
      resize();
      var w = elCanvas.clientWidth;
      var h = elCanvas.clientHeight;
      var spawned = 0;

      for (var i = 0; i < particles.length && spawned < 46; i++) {
        var p = particles[i];
        if (p.active) continue;
        p.active = true;
        p.x = w / 2 + (Math.random() - 0.5) * 60;
        p.y = h * 0.42;
        p.vx = (Math.random() - 0.5) * 7;
        p.vy = -Math.random() * 8 - 3;
        p.size = Math.random() * 7 + 4;
        p.maxLife = Math.random() * 40 + 45;
        p.life = p.maxLife;
        p.color = colors[Math.floor(Math.random() * colors.length)];
        p.angle = Math.random() * Math.PI * 2;
        p.spin = (Math.random() - 0.5) * 0.3;
        spawned++;
      }

      if (!rafId) rafId = requestAnimationFrame(tick);
    }

    function tick() {
      ctx.clearRect(0, 0, elCanvas.clientWidth, elCanvas.clientHeight);
      var alive = false;

      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        if (!p.active) continue;
        p.life--;
        if (p.life <= 0) { p.active = false; continue; }
        alive = true;

        p.vy += 0.32;          // 重力
        p.vx *= 0.995;
        p.x += p.vx;
        p.y += p.vy;
        p.angle += p.spin;

        var alpha = Math.min(1, p.life / 22);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size, p.size * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      if (alive) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = null;
        ctx.clearRect(0, 0, elCanvas.clientWidth, elCanvas.clientHeight);
      }
    }

    window.addEventListener('resize', resize, { passive: true });
    resize();

    return { burst: burst };
  })();

  /* ============================================================
     工具函式
     ============================================================ */

  /** 依權重隨機挑選一個符號（加權 RNG） */
  function pickSymbol() {
    var total = 0;
    for (var i = 0; i < SYMBOLS.length; i++) total += SYMBOLS[i].weight;
    var r = Math.random() * total;
    for (var j = 0; j < SYMBOLS.length; j++) {
      r -= SYMBOLS[j].weight;
      if (r <= 0) return SYMBOLS[j];
    }
    return SYMBOLS[SYMBOLS.length - 1];
  }

  /** 格式化數字（千分位） */
  function fmt(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** 更新畫面數值 */
  function render() {
    elBalance.textContent = fmt(game.balance);
    elBet.textContent = fmt(game.bet);
    elLastWin.textContent = fmt(game.lastWin);
  }

  /** 設定狀態並同步按鈕／播報 */
  function setState(next, message) {
    game.state = next;
    var isIdle = next === STATE.IDLE;
    elSpinBtn.disabled = !isIdle;
    elSpinBtn.classList.toggle('is-spinning', next === STATE.SPINNING);
    elBetBtns.forEach(function (btn) { btn.disabled = !isIdle; });
    if (message) elStatus.textContent = message;
  }

  /** 閃爍指定數值元素 */
  function flash(el) {
    el.classList.remove('is-flash');
    void el.offsetWidth; // 強制重排以重啟動畫
    el.classList.add('is-flash');
  }

  /** 判斷中獎結果 */
  function evaluate(reels) {
    var a = reels[0], b = reels[1], c = reels[2];
    if (a.id === b.id && b.id === c.id) {
      return { type: 'three', symbol: a, multiplier: a.pay3 };
    }
    if (a.id === b.id || b.id === c.id) {
      var matched = a.id === b.id ? a : b;
      return { type: 'two', symbol: matched, multiplier: matched.pay2 };
    }
    return null;
  }

  /** 清除所有計時器（防洩漏） */
  function clearTimers() {
    game.timers.forEach(function (t) {
      clearInterval(t.interval);
      clearTimeout(t.timeout);
    });
    game.timers = [];
  }

  /* ============================================================
     核心流程
     ============================================================ */

  function spin() {
    // 狀態守衛：非待機狀態直接忽略
    if (game.state !== STATE.IDLE) return;

    // 餘額守衛
    if (game.balance < game.bet) {
      elStatus.textContent = '籌碼不足，請降低下注';
      AudioKit.lose();
      return;
    }

    AudioKit.unlock();
    AudioKit.spin();
    clearTimers();
    game.balance -= game.bet;
    game.lastWin = 0;
    render();
    setState(STATE.SPINNING, '轉輪旋轉中…');

    if (reduceMotion) {
      // 減少動態模式：直接決定結果並結算
      game.current = [pickSymbol(), pickSymbol(), pickSymbol()];
      paintReels();
      finishSpin(evaluate(game.current));
      return;
    }

    elReelList.forEach(function (reel, index) {
      // 旋轉視覺
      reel.classList.add('is-spinning');
      reel.classList.remove('is-winning', 'is-stopping');

      var interval = setInterval(function () {
        var s = pickSymbol();
        reel.querySelector('.symbol').textContent = s.glyph;
      }, SPIN_INTERVAL);

      var timeout = setTimeout(function () {
        clearInterval(interval);
        reel.classList.remove('is-spinning');
        reel.classList.add('is-stopping');

        var finalSymbol = pickSymbol();
        game.current[index] = finalSymbol;
        reel.querySelector('.symbol').textContent = finalSymbol.glyph;
        AudioKit.stop();

        setTimeout(function () {
          reel.classList.remove('is-stopping');
        }, 340);

        // 最後一軸停止後進行結算
        if (index === elReelList.length - 1) {
          setState(STATE.EVALUATING, '結算中…');
          setTimeout(function () {
            finishSpin(evaluate(game.current));
          }, 360);
        }
      }, REEL_STOP_TIMES[index]);

      game.timers.push({ interval: interval, timeout: timeout });
    });
  }

  /** 將目前符號寫回轉輪（減少動態模式使用） */
  function paintReels() {
    elReelList.forEach(function (reel, i) {
      reel.querySelector('.symbol').textContent = game.current[i].glyph;
    });
  }

  /** 結算並回到待機 */
  function finishSpin(result) {
    var winAmount = 0;

    if (result) {
      winAmount = game.bet * result.multiplier;
      game.balance += winAmount;
      game.lastWin = winAmount;

      // 標記中獎軸
      elReelList.forEach(function (reel, i) {
        // 三連時全部標記；兩連時標記符合的軸
        if (result.type === 'three' || game.current[i].id === result.symbol.id) {
          reel.classList.add('is-winning');
        }
      });

      if (elMachine) {
        elMachine.classList.add('is-celebrating');
        setTimeout(function () { elMachine.classList.remove('is-celebrating'); }, 520);
      }

      Fx.burst();
      AudioKit.win(result.type === 'three' ? 'big' : 'small');
      elStatus.textContent = result.type === 'three'
        ? '中大獎！' + result.symbol.name + ' 三連，贏得 ' + fmt(winAmount) + ' 籌碼'
        : '中了 ' + result.symbol.name + ' 兩連，贏得 ' + fmt(winAmount) + ' 籌碼';
      flash(elLastWin);
      flash(elBalance);
    } else {
      AudioKit.lose();
      elStatus.textContent = '未中獎，再試一次';
    }

    render();
    setState(STATE.IDLE, elStatus.textContent);
  }

  /* ============================================================
     事件綁定
     ============================================================ */

  elSpinBtn.addEventListener('click', spin);

  elBetBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (game.state !== STATE.IDLE) return;
      var value = parseInt(btn.getAttribute('data-bet'), 10);
      if (isNaN(value) || value <= 0) return;
      game.bet = value;
      elBetBtns.forEach(function (b) {
        var active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      render();
      elStatus.textContent = '下注已設為 ' + fmt(value) + ' 籌碼';
    });
  });

  // 進入頁面時初始化狀態
  render();
  setState(STATE.IDLE, '準備就緒');
})();
