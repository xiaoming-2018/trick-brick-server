// 后台管理前端逻辑(P3:登录 + 改时长)
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';       // 同域,自动带 HttpOnly Cookie
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch('/api/admin' + path, opts);
  }

  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }

  function showApp(authed) {
    $('login').classList.toggle('hidden', authed);
    $('app').classList.toggle('hidden', !authed);
    if (authed) switchTab('levels');   // 默认进"过关时长"tab
  }

  // ---------- 选项卡 ----------
  function switchTab(name) {
    var tabs = document.querySelectorAll('.tabs .tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
    }
    $('tab-levels').classList.toggle('hidden', name !== 'levels');
    $('tab-dashboard').classList.toggle('hidden', name !== 'dashboard');
    // 切到哪个 tab 就加载哪个的数据;看板在可见时才渲染,图表尺寸才正确
    if (name === 'dashboard') loadStats();
    else loadLevels();
  }
  (function bindTabs() {
    var tabs = document.querySelectorAll('.tabs .tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].onclick = (function (el) {
        return function () { switchTab(el.getAttribute('data-tab')); };
      })(tabs[i]);
    }
  })();

  // ---------- 登录 ----------
  function login() {
    var pw = $('pw').value;
    $('login-err').textContent = '';
    api('/login', { method: 'POST', body: JSON.stringify({ password: pw }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok) { $('pw').value = ''; showApp(true); }
        else $('login-err').textContent = (res.d && res.d.error) || '登录失败';
      })
      .catch(function () { $('login-err').textContent = '网络错误'; });
  }
  $('login-btn').onclick = login;
  $('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });

  $('logout').onclick = function () {
    api('/logout', { method: 'POST' }).finally(function () { showApp(false); });
  };

  // ---------- 关卡时长 ----------
  function fmtTime(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); }
    catch (e) { return iso; }
  }

  function loadLevels() {
    api('/levels').then(function (r) {
      if (r.status === 401) { showApp(false); return null; }
      return r.json();
    }).then(function (data) {
      if (!data) return;
      var body = $('lv-body'); body.innerHTML = '';
      data.levels.forEach(function (lv) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td>第 ' + (lv.level_index + 1) + ' 关</td>' +
          '<td>' + (lv.name || '') + '</td>' +
          '<td class="num"><input type="number" min="1" max="100000" value="' + lv.time_seconds + '" data-idx="' + lv.level_index + '"></td>' +
          '<td class="default">' + (lv.default_time != null ? lv.default_time + 's' : '—') + '</td>' +
          '<td class="upd">' + fmtTime(lv.updated_at) + (lv.updated_by ? ' · ' + lv.updated_by : '') + '</td>' +
          '<td></td>';
        var actions = tr.lastElementChild;
        var saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-save'; saveBtn.textContent = '保存';
        saveBtn.onclick = function () { saveLevel(lv.level_index); };
        var resetBtn = document.createElement('button');
        resetBtn.className = 'btn btn-reset'; resetBtn.textContent = '恢复默认';
        resetBtn.onclick = function () {
          tr.querySelector('input').value = lv.default_time;
          saveLevel(lv.level_index);
        };
        actions.appendChild(saveBtn);
        if (lv.default_time != null) actions.appendChild(resetBtn);
        body.appendChild(tr);
      });
    }).catch(function () { toast('加载失败'); });
  }

  function saveLevel(idx) {
    var input = document.querySelector('#lv-body input[data-idx="' + idx + '"]');
    var t = parseInt(input.value, 10);
    if (!(t >= 1)) { toast('时长需为正整数'); return; }
    api('/levels/' + idx, { method: 'PUT', body: JSON.stringify({ time_seconds: t }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok) { toast('第 ' + (idx + 1) + ' 关已保存为 ' + t + 's'); loadLevels(); }
        else toast((res.d && res.d.error) || '保存失败');
      })
      .catch(function () { toast('网络错误'); });
  }

  // ---------- 数据看板(P4) ----------
  var charts = {};
  function pct(x) { return x == null ? '—' : Math.round(x * 100) + '%'; }
  function diffColor(d) {
    // 0 绿 → 100 红
    var h = Math.round((1 - d / 100) * 120);
    return 'hsl(' + h + ',65%,45%)';
  }
  function makeBar(id, labels, data, color, opts) {
    opts = opts || {};
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart($(id).getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [Object.assign({ label: opts.label || '', data: data,
          backgroundColor: color, borderRadius: 5 }, opts.dataset || {})],
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: { legend: { display: !!opts.legend } },
        scales: { y: { beginAtZero: true, max: opts.max, ticks: opts.yticks } },
      },
    });
  }

  function loadStats() {
    var qs = [];
    var f = $('from').value, t = $('to').value;
    if (f) qs.push('from=' + encodeURIComponent(f + 'T00:00:00.000Z'));
    if (t) qs.push('to=' + encodeURIComponent(t + 'T23:59:59.999Z'));
    api('/stats' + (qs.length ? '?' + qs.join('&') : '')).then(function (r) {
      if (r.status === 401) { showApp(false); return null; }
      return r.json();
    }).then(function (s) {
      if (!s) return;
      renderStats(s);
    }).catch(function () { toast('统计加载失败'); });
  }

  function renderStats(s) {
    // 概览
    var ov = $('overview');
    ov.innerHTML =
      box(s.overview.total_runs, '总游玩次数') +
      box(s.overview.cleared_runs, '通关全部') +
      box(s.overview.total_attempts, '关卡尝试总数');
    var hasData = s.overview.total_attempts > 0 || s.overview.total_runs > 0;
    $('empty-tip').classList.toggle('hidden', hasData);

    var labels = s.levels.map(function (l) { return '第' + (l.level_index + 1) + '关'; });

    // 漏斗:到达 vs 通过(distinct run)
    if (charts['ch-funnel']) charts['ch-funnel'].destroy();
    charts['ch-funnel'] = new Chart($('ch-funnel').getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: '到达人数', data: s.levels.map(function (l) { return l.reached; }), backgroundColor: '#93c5fd', borderRadius: 5 },
          { label: '通过人数', data: s.levels.map(function (l) { return l.runs_won; }), backgroundColor: '#3b82f6', borderRadius: 5 },
        ],
      },
      options: { responsive: true, plugins: { legend: { display: true } }, scales: { y: { beginAtZero: true } } },
    });

    makeBar('ch-pass', labels, s.levels.map(function (l) { return l.pass_rate == null ? 0 : Math.round(l.pass_rate * 100); }),
      '#10b981', { label: '通关率%', max: 100 });
    makeBar('ch-attempts', labels, s.levels.map(function (l) { return l.avg_attempts == null ? 0 : +l.avg_attempts.toFixed(2); }),
      '#f59e0b', { label: '平均尝试' });
    makeBar('ch-timeleft', labels, s.levels.map(function (l) { return l.avg_time_left_ratio == null ? 0 : Math.round(l.avg_time_left_ratio * 100); }),
      '#06b6d4', { label: '剩余时间%', max: 100 });
    makeBar('ch-diff', labels, s.levels.map(function (l) { return l.difficulty; }),
      s.levels.map(function (l) { return diffColor(l.difficulty); }), { label: '难度分', max: 100 });

    // 明细表
    var body = $('stats-body'); body.innerHTML = '';
    s.levels.forEach(function (l) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>第' + (l.level_index + 1) + '关<br><span class="upd">' + (l.name || '') + '</span></td>' +
        '<td>' + l.reached + ' / ' + l.runs_won + '</td>' +
        '<td>' + pct(l.pass_rate) + '</td>' +
        '<td>' + (l.avg_attempts == null ? '—' : l.avg_attempts.toFixed(2)) + '</td>' +
        '<td>' + pct(l.first_try_pass_rate) + '</td>' +
        '<td>' + (l.avg_time_left_ratio == null ? '—' : Math.round(l.avg_time_left_ratio * 100) + '%') + '</td>' +
        '<td>' + (l.avg_fail_completion == null ? '—' : Math.round(l.avg_fail_completion) + '%') + '</td>' +
        '<td><span class="diff-pill" style="background:' + diffColor(l.difficulty) + '">' + l.difficulty + '</span></td>' +
        '<td><span class="badge ' + l.suggestion.level + '">' + l.suggestion.text + '</span></td>';
      body.appendChild(tr);
    });
  }

  function box(v, label) {
    return '<div class="stat-box"><div class="v">' + (v || 0) + '</div><div class="l">' + label + '</div></div>';
  }

  $('apply').onclick = loadStats;
  $('clear-range').onclick = function () { $('from').value = ''; $('to').value = ''; loadStats(); };

  // 清除历史数据(二次确认,不可撤销;只清埋点,不影响关卡时长配置)
  $('clear-data').onclick = function () {
    if (!confirm('确定清除全部历史埋点数据吗?\n\n将删除所有游玩记录与关卡尝试,难度分析数据归零。\n关卡时长配置不受影响。此操作不可撤销!')) return;
    api('/data/clear', { method: 'POST' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok) {
          var del = (res.d && res.d.deleted) || {};
          toast('已清除 ' + (del.run || 0) + ' 条游玩 · ' + (del.level_attempt || 0) + ' 条尝试');
          loadStats();
        } else toast((res.d && res.d.error) || '清除失败');
      })
      .catch(function () { toast('网络错误'); });
  };

  // ---------- 使用帮助弹窗 ----------
  $('help-btn').onclick = function () { $('help-modal').classList.add('show'); };
  $('help-close').onclick = function () { $('help-modal').classList.remove('show'); };
  $('help-modal').onclick = function (e) { if (e.target.id === 'help-modal') $('help-modal').classList.remove('show'); };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('help-modal').classList.remove('show'); });

  // ---------- 启动:检查登录态 ----------
  api('/me').then(function (r) { return r.json(); })
    .then(function (d) { showApp(!!(d && d.authed)); })
    .catch(function () { showApp(false); });
})();
