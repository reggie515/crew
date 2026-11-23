(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var QS = new URLSearchParams(location.search);
  var DEMO = QS.has('demo') || !CFG.API_URL || !CFG.LIFF_ID;
  var COLORS = ['#2563eb', '#d97706', '#059669', '#db2777', '#7c3aed', '#0891b2', '#65a30d'];
  var WD = '日一二三四五六';
  var SLOTS = ['全天', '上午', '下午'];

  var S = null;          // 伺服器回傳的狀態
  var lastSync = null;
  var busy = false;
  var demoUser = null;
  var ui = { tab: 'grid', showPast: false, modal: null, chart: { who: '', days: 7 } };

  var $app = document.getElementById('app');
  var $modal = document.getElementById('modal');
  var $toast = document.getElementById('toast');

  /* ───────── 小工具 ───────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function parseYmd(s) { var p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function addDays(s, n) { var d = parseYmd(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function md(s) { var d = parseYmd(s); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); }
  function dow(s) { return parseYmd(s).getUTCDay(); }
  function wd(s) { return WD.charAt(dow(s)); }
  function mdw(s) { return md(s) + '（' + wd(s) + '）'; }
  function range(a, b) { var out = []; for (var d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; }
  function color(chief) {
    var i = S.chiefs.findIndex(function (c) { return c.name === chief; });
    return i < 0 ? '#64748b' : COLORS[i % COLORS.length];
  }
  function overlap(a, b) { return a === '全天' || b === '全天' || a === b; }
  function canModify(b) { return S.me && (S.me.isAdmin || (b.chief === S.me.name && b.date >= S.today)); }
  function byId(id) { return S.bookings.find(function (b) { return b.id === id; }); }
  function cellBookings(date, master) {
    return S.bookings.filter(function (b) { return b.date === date && b.master === master; });
  }
  function slotFree(date, master, slot, exceptId) {
    return !S.bookings.some(function (b) {
      return b.id !== exceptId && b.date === date && b.master === master && overlap(b.slot, slot);
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function toast(msg, err) {
    $toast.textContent = msg;
    $toast.className = 'toast' + (err ? ' err' : '');
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { $toast.className = 'toast hidden'; }, err ? 6000 : 2800);
  }

  /* ───────── 後端呼叫 ───────── */
  function idToken() {
    return DEMO ? window.DemoBackend.token(demoUser) : window.liff.getIDToken();
  }

  async function api(action, data, quiet) {
    if (busy && quiet) return;
    busy = true;
    var payload = Object.assign({ action: action, idToken: idToken() }, data || {});
    var res;
    try {
      if (DEMO) {
        await sleep(120);
        res = window.DemoBackend.call(payload);
      } else {
        var r = await fetch(CFG.API_URL, { method: 'POST', body: JSON.stringify(payload) });
        res = await r.json();
      }
    } catch (e) {
      busy = false;
      if (!quiet) toast('連線失敗，請檢查網路後再試一次', true);
      throw e;
    }
    busy = false;
    if (!res.ok) {
      if (res.code === 'AUTH' && !DEMO) {
        window.liff.logout();
        window.liff.login({ redirectUri: location.href });
      }
      if (!quiet) toast(res.error, true);
      throw new Error(res.error);
    }
    S = res.data;
    lastSync = new Date();
    if (res.msg && !quiet) toast(res.msg);
    if (!ui.chart.who && S.masters.length) ui.chart.who = S.masters[0];
    render();
    return res;
  }

  function refresh(quiet) { return api('init', {}, quiet).catch(function () { }); }

  /* ───────── 畫面 ───────── */
  function render() {
    if (!S) { $app.innerHTML = '<div class="loading">載入中…</div>'; return; }
    if (!S.me) { $app.innerHTML = demoBar() + bindView(); return; }
    var tabs = [['grid', '排班表'], ['mine', '我的預約'], ['far', '遠期登記'], ['log', '變更紀錄']];
    var html = '<header class="top">' + demoBar() +
      '<div class="top-row"><h1>工班調度</h1>' +
      '<span class="me">' + esc(S.me.name) + (S.me.isAdmin ? ' <span class="badge">管理員</span>' : '') + '</span>' +
      '<button class="icon-btn" data-act="refresh" title="重新整理">↻ ' + (lastSync ? pad(lastSync.getHours()) + ':' + pad(lastSync.getMinutes()) : '') + '</button></div>' +
      '<nav class="tabs">' + tabs.map(function (t) {
        return '<button data-act="tab" data-tab="' + t[0] + '" class="' + (ui.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>';
      }).join('') + '</nav></header>';
    if (ui.tab === 'grid') html += gridView();
    else if (ui.tab === 'mine') html += mineView();
    else if (ui.tab === 'far') html += farView();
    else html += logView();
    html += '<button class="btn fab" data-act="chart">🖼 排班圖</button>';
    var y = window.scrollY;
    $app.innerHTML = html;
    window.scrollTo(0, y);
    var top = $app.querySelector('.top');
    if (top) document.documentElement.style.setProperty('--hdr', top.offsetHeight + 'px');
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function demoBar() {
    if (!DEMO) return '';
    return '<div class="demo-bar">🧪 示範模式（資料只存在這台裝置）｜切換身分：<select data-change="demo-user">' +
      window.DemoBackend.users.map(function (u) {
        return '<option value="' + u.id + '"' + (u === demoUser ? ' selected' : '') + '>' + esc(u.name) + (u.chief ? '' : '（未綁定）') + '</option>';
      }).join('') + '</select><button data-act="demo-reset">重置資料</button></div>';
  }

  function bindView() {
    return '<div class="bind"><h2>第一次使用</h2>' +
      '<p>嗨 ' + esc(S.user.name) + '，請選擇你是哪一位主任。選好之後這個 LINE 帳號就會固定代表你，之後打開不用再選。</p>' +
      '<div class="choices">' + S.chiefs.map(function (c) {
        return '<button data-act="bind" data-chief="' + esc(c.name) + '"' + (c.bound ? ' disabled' : '') + '>' +
          esc(c.name) + (c.bound ? '<br><small>已綁定</small>' : '') + '</button>';
      }).join('') + '</div>' +
      '<p style="margin-top:16px">選錯了或名字已被綁定，請聯絡管理員到試算表「主任」頁清除。</p></div>';
  }

  function gridView() {
    var from = ui.showPast ? addDays(S.today, -7) : S.today;
    var days = range(from, S.lastDay);
    var html = '<div class="toolbar"><span>今天起 ' + S.days + ' 天（到 ' + mdw(S.lastDay) + '）</span>' +
      '<label><input type="checkbox" data-change="past"' + (ui.showPast ? ' checked' : '') + '>顯示過去 7 天</label></div>';
    html += '<div class="legend">' + S.chiefs.map(function (c) {
      return '<span><i style="background:' + color(c.name) + '"></i>' + esc(c.name) + '</span>';
    }).join('') + '</div>';
    html += '<div class="grid" style="--cols:' + S.masters.length + '"><div class="gh">日期</div>' +
      S.masters.map(function (m) { return '<div class="gh">' + esc(m) + '</div>'; }).join('');
    days.forEach(function (d) {
      var w = dow(d);
      var rowCls = (d === S.today ? ' row-today' : (w === 0 || w === 6) ? ' row-we' : '') + (d < S.today ? ' row-past' : '');
      html += '<div class="gd' + rowCls + (w === 0 ? ' sun' : w === 6 ? ' sat' : '') + '"><b>' + md(d) + '</b>' +
        (d === S.today ? '今天' : '週' + wd(d)) + '</div>';
      S.masters.forEach(function (m) {
        html += '<div class="gc' + rowCls + '">' + cellHtml(d, m) + '</div>';
      });
    });
    return html + '</div><div style="height:80px"></div>';
  }

  function cellHtml(d, m) {
    var bs = cellBookings(d, m);
    var past = d < S.today;
    var full = bs.find(function (b) { return b.slot === '全天'; });
    if (full) return cardHtml(full, false);
    if (!bs.length) return past ? '' : '<button class="add" data-act="new" data-date="' + d + '" data-master="' + esc(m) + '" aria-label="預約">＋</button>';
    return ['上午', '下午'].map(function (slot) {
      var b = bs.find(function (x) { return x.slot === slot; });
      if (b) return cardHtml(b, true);
      return past ? '<div style="flex:1"></div>' :
        '<button class="add" data-act="new" data-date="' + d + '" data-master="' + esc(m) + '" data-slot="' + slot + '"><small>' + slot + ' ＋</small></button>';
    }).join('');
  }

  function cardHtml(b, half) {
    var mine = S.me && b.chief === S.me.name;
    return '<button class="card' + (mine ? ' mine' : '') + (half ? ' half' : '') + '" style="--c:' + color(b.chief) + '" data-act="view" data-id="' + b.id + '">' +
      '<div class="s">' + (half ? '<span class="h">' + (b.slot === '上午' ? '上' : '下') + '</span>' : '') + esc(b.site) +
      (b.custom ? '<span class="tag">自訂</span>' : '') + '</div>' +
      '<div class="c">' + esc(b.chief) + (b.note ? ' · 📝' : '') + '</div></button>';
  }

  function mineView() {
    var list = S.bookings.filter(function (b) { return b.chief === S.me.name && b.date >= S.today; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot); });
    var far = S.far.filter(function (f) { return f.chief === S.me.name && (f.status === '等待中' || f.status === '衝突'); });
    var html = '<div class="section"><h2>我接下來的預約（' + list.length + '）</h2>';
    html += list.length ? list.map(function (b) {
      return '<div class="item" style="--c:' + color(b.chief) + '"><div class="main"><div class="t">' + mdw(b.date) + ' ' + esc(b.master) + ' · ' + b.slot + '</div>' +
        '<div class="sub">' + esc(b.site) + (b.note ? '｜' + esc(b.note) : '') + '</div></div>' +
        '<button class="btn sec sm" data-act="view" data-id="' + b.id + '">管理</button></div>';
    }).join('') : '<div class="empty">目前沒有預約，到「排班表」點空格就能預約</div>';
    if (far.length) {
      html += '<h2 style="margin-top:20px">我的遠期登記</h2>' + far.map(farItem).join('');
    }
    return html + '</div>';
  }

  function farRank(f) {
    var same = S.far.filter(function (x) {
      return (x.status === '等待中') && x.date === f.date && x.master === f.master && overlap(x.slot, f.slot);
    }).sort(function (a, b) { return a.registeredAt < b.registeredAt ? -1 : 1; });
    return same.findIndex(function (x) { return x.id === f.id; }) + 1;
  }

  function farItem(f) {
    var cls = { '等待中': 'st-wait', '已轉正': 'st-ok', '衝突': 'st-bad', '已取消': 'st-off' }[f.status] || 'st-off';
    var rank = f.status === '等待中' ? farRank(f) : 0;
    var canCancel = (S.me.isAdmin || f.chief === S.me.name) && (f.status === '等待中' || f.status === '衝突');
    return '<div class="item" style="--c:' + color(f.chief) + '"><div class="main">' +
      '<div class="t">' + mdw(f.date) + ' ' + esc(f.master) + ' · ' + f.slot + '</div>' +
      '<div class="sub">' + esc(f.site) + '（' + esc(f.chief) + '）' + (f.note ? '｜' + esc(f.note) : '') + '</div>' +
      '<div class="sub">登記於 ' + esc(f.registeredAt.slice(5, 16)) + (rank ? '｜第 ' + rank + ' 順位' : '') + '</div>' +
      (f.reason && f.status !== '已取消' ? '<div class="sub" style="color:' + (f.status === '衝突' ? 'var(--danger)' : 'inherit') + '">' + esc(f.reason) + '</div>' : '') +
      '</div><div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end"><span class="st ' + cls + '">' + f.status + '</span>' +
      (canCancel ? '<button class="btn danger sm" data-act="far-cancel" data-id="' + f.id + '">取消</button>' : '') + '</div></div>';
  }

  function farView() {
    var list = S.far.slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : a.registeredAt < b.registeredAt ? -1 : 1;
    });
    return '<div class="section"><div class="hint">' + mdw(S.lastDay) + ' 以後的日期還不能直接預約，請先在這裡登記。<br>' +
      '同一天同一位師傅，<b>先登記的人優先</b>。日期進入 ' + S.days + ' 天內時，系統會自動轉成正式預約；如果那格已經被人佔走，會標示「衝突」，由管理員協調。</div>' +
      '<button class="btn" style="width:100%;margin-bottom:14px" data-act="far-new">＋ 新增遠期登記</button>' +
      (list.length ? list.map(farItem).join('') : '<div class="empty">目前沒有遠期登記</div>') + '</div><div style="height:70px"></div>';
  }

  function logView() {
    if (!S.logs.length) return '<div class="empty">還沒有任何紀錄</div>';
    return '<div style="padding-top:8px">' + S.logs.map(function (l) {
      return '<div class="log"><div class="meta">' + esc(l.time.slice(5, 16)) + '｜' + esc(l.actor) + '</div><b>' + esc(l.action) + '</b>' + esc(l.content) + '</div>';
    }).join('') + '<p class="empty" style="padding:16px">只顯示最近 50 筆，完整紀錄在試算表「紀錄」頁</p></div><div style="height:70px"></div>';
  }

  /* ───────── 彈出視窗 ───────── */
  function openModal(html) {
    $modal.innerHTML = '<div class="sheet">' + html + '</div>';
    $modal.classList.remove('hidden');
    ui.modal = true;
  }
  function closeModal() {
    $modal.classList.add('hidden');
    $modal.innerHTML = '';
    ui.modal = null;
  }

  function siteField(current, chief) {
    var sites = S.sites.slice().sort(function (a, b) { return (b.chief === chief) - (a.chief === chief); });
    var known = sites.some(function (s) { return s.name === current; });
    var custom = !!current && !known;
    return '<div class="field"><label>工地</label><select name="site" data-change="site">' +
      '<option value="">請選擇工地</option>' +
      sites.map(function (s) {
        return '<option value="' + esc(s.name) + '"' + (s.name === current ? ' selected' : '') + '>' +
          (s.chief === chief ? '★ ' : '') + esc(s.name) + '</option>';
      }).join('') +
      '<option value="__custom"' + (custom ? ' selected' : '') + '>➕ 其他（臨時案場／保固，自行輸入）</option></select>' +
      '<input name="customSite" maxlength="60" placeholder="例如：大安區保固（王先生）" value="' + (custom ? esc(current) : '') + '" class="' + (custom ? '' : 'hidden') + '"></div>';
  }

  function slotField(date, master, current, exceptId) {
    return '<div class="field"><label>時段</label><div class="seg" id="slots">' + slotOptions(date, master, current, exceptId) + '</div></div>';
  }
  function slotOptions(date, master, current, exceptId) {
    var opts = SLOTS.map(function (s) { return { s: s, free: !date || !master || slotFree(date, master, s, exceptId) }; });
    if (!opts.some(function (o) { return o.s === current && o.free; })) {
      var first = opts.find(function (o) { return o.free; });
      current = first ? first.s : current;
    }
    return opts.map(function (o) {
      return '<label><input type="radio" name="slot" value="' + o.s + '"' + (o.s === current ? ' checked' : '') + (o.free ? '' : ' disabled') + '><span>' + o.s + '</span></label>';
    }).join('');
  }

  function chiefSelect(name, current, exclude) {
    return '<select name="' + name + '">' + S.chiefs.filter(function (c) { return c.name !== exclude; }).map(function (c) {
      return '<option' + (c.name === current ? ' selected' : '') + '>' + esc(c.name) + '</option>';
    }).join('') + '</select>';
  }
  function masterSelect(current) {
    return '<select name="master" data-change="recalc">' + S.masters.map(function (m) {
      return '<option' + (m === current ? ' selected' : '') + '>' + esc(m) + '</option>';
    }).join('') + '</select>';
  }

  function bookingForm(opts) {
    // opts: {mode:'new'|'edit'|'far', date, master, slot, booking}
    var b = opts.booking || {};
    var admin = S.me.isAdmin;
    var chief = b.chief || S.me.name;
    var h = '<form data-form="' + opts.mode + '"' + (b.id ? ' data-id="' + b.id + '"' : '') + '>';
    if (opts.mode === 'new') {
      h += '<h3>預約 ' + esc(opts.master) + '</h3><div class="lead">' + mdw(opts.date) + '</div>' +
        '<input type="hidden" name="date" value="' + opts.date + '"><input type="hidden" name="master" value="' + esc(opts.master) + '">';
    } else {
      var isFar = opts.mode === 'far';
      h += '<h3>' + (isFar ? '新增遠期登記' : '修改預約') + '</h3><div class="lead">' +
        (isFar ? '可登記 ' + mdw(addDays(S.lastDay, 1)) + ' 以後的日期' : '修改後會留下紀錄') + '</div>' +
        '<div class="field"><label>日期</label><input type="date" name="date" data-change="recalc" required value="' + (b.date || (isFar ? addDays(S.lastDay, 1) : '')) + '" ' +
        (isFar ? 'min="' + addDays(S.lastDay, 1) + '" max="' + addDays(S.today, 366) + '"' : 'min="' + S.today + '" max="' + S.lastDay + '"') + '></div>' +
        '<div class="field"><label>師傅</label>' + masterSelect(b.master || opts.master || S.masters[0]) + '</div>';
    }
    var sd = opts.mode === 'far' ? null : (b.date || opts.date);
    var sm = opts.mode === 'far' ? null : (b.master || opts.master);
    h += slotField(sd, sm, b.slot || opts.slot || '全天', b.id);
    if (admin) h += '<div class="field"><label>主任（管理員可代填）</label>' + chiefSelect('chief', chief) + '</div>';
    h += siteField(b.site || '', chief);
    h += '<div class="field"><label>備註（選填）</label><textarea name="note" maxlength="200" placeholder="例如：灌漿、需要帶切割機">' + esc(b.note || '') + '</textarea></div>';
    h += '<div class="actions"><button type="button" class="btn sec" data-act="close">取消</button><button class="btn" type="submit">' +
      (opts.mode === 'edit' ? '儲存修改' : opts.mode === 'far' ? '送出登記' : '確認預約') + '</button></div></form>';
    return h;
  }

  function viewModal(b) {
    var h = '<h3 style="display:flex;align-items:center;gap:8px"><i style="width:12px;height:12px;border-radius:3px;background:' + color(b.chief) + ';display:inline-block"></i>' + esc(b.site) +
      (b.custom ? '<span class="tag">自訂</span>' : '') + '</h3>' +
      '<dl class="kv"><dt>日期</dt><dd>' + mdw(b.date) + '</dd><dt>師傅</dt><dd>' + esc(b.master) + '・' + b.slot + '</dd>' +
      '<dt>主任</dt><dd>' + esc(b.chief) + '</dd>' + (b.note ? '<dt>備註</dt><dd>' + esc(b.note) + '</dd>' : '') +
      '<dt>建立</dt><dd style="font-size:13px;color:var(--muted)">' + esc(b.createdBy) + '｜' + esc(b.createdAt.slice(5, 16)) +
      (b.updatedAt && b.updatedAt !== b.createdAt ? '<br>最後修改 ' + esc(b.updatedAt.slice(5, 16)) : '') + '</dd></dl>';
    if (canModify(b)) {
      h += '<div class="actions"><button class="btn sec" data-act="edit" data-id="' + b.id + '">修改</button>' +
        '<button class="btn sec" data-act="transfer" data-id="' + b.id + '">轉讓</button>' +
        '<button class="btn danger" data-act="release" data-id="' + b.id + '">釋出</button></div>' +
        '<div class="tip">私下協調好換班後，用「轉讓」把這格直接改給對方；不需要這天的師傅了就按「釋出」。</div>';
    } else {
      h += '<div class="tip">需要這個時段，請私下和 <b>' + esc(b.chief) + '</b> 協調。談好之後，請 ' + esc(b.chief) + ' 打開這格按「轉讓」改給你，系統會留下紀錄。</div>';
    }
    h += '<div class="actions"><button class="btn sec" data-act="close">關閉</button></div>';
    openModal(h);
  }

  function transferModal(b) {
    var others = S.chiefs.filter(function (c) { return c.name !== b.chief; });
    openModal('<form data-form="transfer" data-id="' + b.id + '"><h3>轉讓預約</h3>' +
      '<div class="lead">' + mdw(b.date) + ' ' + esc(b.master) + '・' + b.slot + '（目前：' + esc(b.chief) + '）</div>' +
      '<div class="field"><label>轉讓給</label>' + chiefSelect('toChief', others[0] && others[0].name, b.chief) + '</div>' +
      siteField(b.site, others[0] && others[0].name) +
      '<div class="field"><label>備註</label><textarea name="note" maxlength="200">' + esc(b.note) + '</textarea></div>' +
      '<div class="tip">記得選對方要去的工地。轉讓後這格就屬於對方，你不能再修改。</div>' +
      '<div class="actions"><button type="button" class="btn sec" data-act="close">取消</button><button class="btn" type="submit">確認轉讓</button></div></form>');
  }

  function confirmModal(title, body, act, id, label) {
    openModal('<h3>' + title + '</h3><div class="lead">' + body + '</div><div class="actions">' +
      '<button class="btn sec" data-act="close">取消</button><button class="btn" style="background:var(--danger)" data-act="' + act + '" data-id="' + id + '">' + label + '</button></div>');
  }

  /* ───────── 排班圖（產生圖片給師傅） ───────── */
  function chartModal() {
    var c = ui.chart;
    var whoOpts = S.masters.concat(['全員']);
    var h = '<h3>產生排班圖</h3><div class="lead">做成圖片傳給師傅</div>' +
      '<div class="field"><label>師傅</label><div class="chips">' + whoOpts.map(function (w) {
        return '<button type="button" data-act="chart-who" data-v="' + esc(w) + '" class="' + (c.who === w ? 'on' : '') + '">' + esc(w) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="field"><label>天數</label><div class="chips">' + [7, 14, 30].map(function (n) {
        return '<button type="button" data-act="chart-days" data-v="' + n + '" class="' + (c.days === n ? 'on' : '') + '">' + n + ' 天</button>';
      }).join('') + '</div></div>';
    var url = drawChart(c.who, c.days);
    h += '<div class="preview"><img src="' + url + '" alt="排班圖"></div>' +
      '<div class="tip">📱 手機：<b>長按圖片</b> →「儲存」或「分享」，就能用 LINE 傳給師傅。<br>💻 電腦：按下面的「下載圖片」。</div>' +
      '<div class="actions"><button class="btn sec" data-act="close">關閉</button>' +
      '<a class="btn" style="text-align:center;text-decoration:none" download="排班_' + esc(c.who) + '_' + S.today + '.png" href="' + url + '">下載圖片</a></div>';
    openModal(h);
  }

  function wrap(ctx, text, maxW, maxLines) {
    var lines = [], line = '';
    for (var i = 0; i < text.length; i++) {
      var t = line + text[i];
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = text[i]; } else line = t;
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      var l = lines[maxLines - 1];
      while (l && ctx.measureText(l + '…').width > maxW) l = l.slice(0, -1);
      lines[maxLines - 1] = l + '…';
    }
    return lines;
  }

  function drawChart(who, n) {
    var FONT = '"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif';
    var days = range(S.today, addDays(S.today, n - 1));
    var all = who === '全員';
    var cols = all ? S.masters : [who];
    var W = 1080, P = 40, dateW = all ? 150 : 200, headH = all ? 170 : 150, colHeadH = all ? 60 : 0;
    var rowH = all ? 120 : 110;
    var H = headH + colHeadH + rowH * days.length + 70;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#1e293b'; g.fillRect(0, 0, W, headH - 30);
    g.fillStyle = '#fff'; g.font = 'bold 52px ' + FONT; g.textBaseline = 'middle';
    g.fillText((all ? '全員' : who) + ' 排班表', P, 58);
    g.font = '30px ' + FONT; g.fillStyle = '#cbd5e1';
    g.fillText(mdw(days[0]) + ' ～ ' + mdw(days[days.length - 1]), P, 108);
    var y = headH;
    var colW = (W - P * 2 - dateW) / cols.length;
    if (all) {
      g.font = 'bold 30px ' + FONT; g.fillStyle = '#0f172a';
      cols.forEach(function (m, i) { g.textAlign = 'center'; g.fillText(m, P + dateW + colW * i + colW / 2, y + 26); });
      g.textAlign = 'left';
      y += colHeadH;
    }
    days.forEach(function (d, ri) {
      var w = dow(d);
      if (w === 0 || w === 6) { g.fillStyle = '#f8fafc'; g.fillRect(P, y, W - P * 2, rowH); }
      g.strokeStyle = '#e2e8f0'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(P, y); g.lineTo(W - P, y); g.stroke();
      g.fillStyle = (w === 0 || w === 6) ? '#dc2626' : '#0f172a';
      g.font = 'bold 36px ' + FONT; g.fillText(md(d), P + 8, y + rowH / 2 - 16);
      g.font = '26px ' + FONT; g.fillStyle = '#64748b'; g.fillText('週' + wd(d), P + 8, y + rowH / 2 + 22);
      cols.forEach(function (m, ci) {
        var x = P + dateW + colW * ci + 8, cw = colW - 16;
        var bs = cellBookings(d, m).sort(function (a, b) { return SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot); });
        if (!bs.length) {
          g.fillStyle = '#cbd5e1'; g.font = '28px ' + FONT; g.fillText('—', x + 8, y + rowH / 2);
          return;
        }
        var bh = (rowH - 16) / bs.length;
        bs.forEach(function (b, bi) {
          var by = y + 8 + bh * bi;
          var c = color(b.chief);
          g.fillStyle = c; g.globalAlpha = .12; g.fillRect(x, by + 2, cw, bh - 4); g.globalAlpha = 1;
          g.fillRect(x, by + 2, 8, bh - 4);
          var label = (b.slot !== '全天' ? b.slot + '｜' : '') + b.site;
          var single = bs.length === 1;
          g.fillStyle = '#0f172a';
          g.font = 'bold ' + (single ? (all ? 28 : 34) : 24) + 'px ' + FONT;
          var lines = wrap(g, label, cw - 30, single && all ? 2 : 1);
          var lh = single ? (all ? 32 : 40) : 26;
          var sub = b.chief + (b.note && !all ? '｜' + b.note : '');
          var total = lines.length * lh + (single ? 30 : 0);
          var ty = by + bh / 2 - total / 2 + lh / 2;
          lines.forEach(function (l, li) { g.fillText(l, x + 20, ty + li * lh); });
          if (single) {
            g.font = (all ? 22 : 26) + 'px ' + FONT; g.fillStyle = '#475569';
            g.fillText(wrap(g, sub, cw - 30, 1)[0], x + 20, ty + lines.length * lh + 4);
          }
        });
      });
      y += rowH;
      if (ri === days.length - 1) { g.beginPath(); g.moveTo(P, y); g.lineTo(W - P, y); g.stroke(); }
    });
    g.font = '22px ' + FONT; g.fillStyle = '#94a3b8';
    var now = new Date();
    g.fillText('產生時間 ' + (now.getMonth() + 1) + '/' + now.getDate() + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + '｜以系統最新排班為準', P, H - 34);
    return cv.toDataURL('image/png');
  }

  /* ───────── 事件 ───────── */
  var actions = {
    refresh: function () { refresh(false).then(function () { toast('已更新'); }); },
    tab: function (el) { ui.tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
    close: closeModal,
    bind: function (el) { api('bind', { chief: el.dataset.chief }).catch(function () { }); },
    'new': function (el) {
      openModal(bookingForm({ mode: 'new', date: el.dataset.date, master: el.dataset.master, slot: el.dataset.slot }));
    },
    view: function (el) { var b = byId(el.dataset.id); if (b) viewModal(b); },
    edit: function (el) { openModal(bookingForm({ mode: 'edit', booking: byId(el.dataset.id) })); },
    transfer: function (el) { transferModal(byId(el.dataset.id)); },
    release: function (el) {
      var b = byId(el.dataset.id);
      confirmModal('確定要釋出？', mdw(b.date) + ' ' + esc(b.master) + '・' + b.slot + '（' + esc(b.site) + '）會變成空格，其他主任就能預約。', 'release-yes', b.id, '確定釋出');
    },
    'release-yes': function (el) { closeModal(); api('release', { id: el.dataset.id }).catch(function () { }); },
    'far-new': function () { openModal(bookingForm({ mode: 'far' })); },
    'far-cancel': function (el) { confirmModal('取消遠期登記？', '取消後就會失去目前的順位。', 'far-cancel-yes', el.dataset.id, '確定取消'); },
    'far-cancel-yes': function (el) { closeModal(); api('farCancel', { id: el.dataset.id }).catch(function () { }); },
    chart: chartModal,
    'chart-who': function (el) { ui.chart.who = el.dataset.v; chartModal(); },
    'chart-days': function (el) { ui.chart.days = +el.dataset.v; chartModal(); },
    'demo-reset': function () {
      confirmModal('重置示範資料？', '你在示範模式新增或修改的內容都會清掉，回到一開始的範例資料。', 'demo-reset-yes', '', '確定重置');
    },
    'demo-reset-yes': function () {
      closeModal();
      window.DemoBackend.reset();
      demoUser = window.DemoBackend.users[0];
      ui.tab = 'grid'; ui.showPast = false;
      api('init').then(function () { window.scrollTo(0, 0); toast('✅ 已重置為範例資料，身分切回「' + demoUser.name + '」'); }).catch(function () { });
    }
  };

  document.addEventListener('click', function (e) {
    if (e.target === $modal) { closeModal(); return; }
    var el = e.target.closest('[data-act]');
    if (!el || !actions[el.dataset.act]) return;
    e.preventDefault();
    actions[el.dataset.act](el);
  });

  document.addEventListener('change', function (e) {
    var el = e.target, kind = el.dataset && el.dataset.change;
    if (!kind) return;
    if (kind === 'past') { ui.showPast = el.checked; render(); }
    else if (kind === 'site') {
      var input = el.form.querySelector('[name=customSite]');
      input.classList.toggle('hidden', el.value !== '__custom');
      if (el.value === '__custom') input.focus();
    } else if (kind === 'recalc') {
      var f = el.form, mode = f.dataset.form;
      if (mode === 'far') return;
      var cur = (f.querySelector('[name=slot]:checked') || {}).value;
      f.querySelector('#slots').innerHTML = slotOptions(f.date.value, f.master.value, cur, f.dataset.id);
    } else if (kind === 'demo-user') {
      demoUser = window.DemoBackend.users.find(function (u) { return u.id === el.value; });
      S = null; closeModal(); render(); refresh(false);
    }
  });

  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f.dataset || !f.dataset.form) return;
    e.preventDefault();
    var mode = f.dataset.form;
    var sel = f.querySelector('[name=site]');
    var site = sel ? (sel.value === '__custom' ? f.customSite.value.trim() : sel.value) : '';
    if (!site) { toast('請選擇或填寫工地', true); return; }
    var slotEl = f.querySelector('[name=slot]:checked');
    var data = { site: site, note: f.note.value };
    var action;
    if (mode === 'transfer') {
      action = 'transfer';
      data.id = f.dataset.id;
      data.toChief = f.toChief.value;
    } else {
      if (!slotEl) { toast('這格已經沒有空的時段', true); return; }
      data.slot = slotEl.value;
      data.date = f.date.value;
      data.master = f.master.value;
      if (f.chief) data.chief = f.chief.value;
      if (!data.date) { toast('請選擇日期', true); return; }
      action = mode === 'new' ? 'book' : mode === 'edit' ? 'edit' : 'farAdd';
      if (mode === 'edit') data.id = f.dataset.id;
    }
    var btn = f.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = '送出中…';
    api(action, data).then(function () {
      closeModal();
      if (mode === 'far') { ui.tab = 'far'; render(); }
    }).catch(function () {
      btn.disabled = false; btn.textContent = '再試一次';
      refresh(true);
    });
  });

  // 即時更新：每 30 秒、以及切回畫面時自動抓最新資料（彈出視窗開著時不打斷）
  setInterval(function () { if (!document.hidden && !ui.modal && S) refresh(true); }, 30000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !ui.modal && S) refresh(true); });

  /* ───────── 啟動 ───────── */
  function loadScript(src) {
    return new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = function () { bad(new Error('無法載入 ' + src)); };
      document.head.appendChild(s);
    });
  }

  async function boot() {
    try {
      if (DEMO) {
        await loadScript('mock-gas.js');
        await loadScript('apps-script/Code.js');
        window.DemoBackend.ensure();
        demoUser = window.DemoBackend.users[0];
      } else {
        await loadScript('https://static.line-scdn.net/liff/edge/2/sdk.js');
        await window.liff.init({ liffId: CFG.LIFF_ID });
        if (!window.liff.isLoggedIn()) { window.liff.login({ redirectUri: location.href }); return; }
      }
      await api('init');
    } catch (e) {
      $app.innerHTML = '<div class="empty">⚠️ 無法啟動：' + esc(e.message || e) + '<br><br><button class="btn" onclick="location.reload()">重新載入</button></div>';
    }
  }
  boot();
})();
