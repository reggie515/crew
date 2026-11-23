/**
 * 工班調度系統 — Google Apps Script 後端
 *
 * 用法（詳見 部署教學.md）：
 *   1. 在 Google 試算表「擴充功能 → Apps Script」貼上本檔全部內容
 *   2. 選擇函式 setup 並按「執行」一次（會建立所有工作表）
 *   3. 「部署 → 新增部署 → 網頁應用程式」，執行身分：我，存取權：所有人
 */

var TZ = 'Asia/Taipei';
var SLOTS = ['全天', '上午', '下午'];

var SCHEMA = {
  '設定': ['項目', '值', '說明'],
  '師傅': ['名稱', '啟用'],
  '主任': ['名稱', '角色', '啟用', 'LINE_USER_ID', 'LINE名稱', '綁定時間'],
  '工地': ['名稱', '負責主任', '地址', '啟用'],
  '預約': ['ID', '日期', '師傅', '時段', '主任', '工地', '自訂工地', '備註', '建立者', '建立時間', '更新時間'],
  '遠期登記': ['ID', '日期', '師傅', '時段', '主任', '工地', '自訂工地', '備註', '登記時間', '狀態', '處理說明', '預約ID'],
  '紀錄': ['時間', '操作者', '動作', 'ID', '內容']
};
// 這些工作表整張設成純文字，避免日期 / ID 被試算表自動轉格式
var TEXT_SHEETS = ['主任', '預約', '遠期登記', '紀錄'];

var SEED_MASTERS = ['阿得', '阿佑', '小安'];
var SEED_CHIEFS = ['其駿', '宇晉', '祺翊', '振宏', '奕賢'];

/* ───────────────────────── 安裝 ───────────────────────── */

function setup() {
  var ss = SpreadsheetApp.getActive();
  if (ss.setSpreadsheetTimeZone) ss.setSpreadsheetTimeZone(TZ);
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = SCHEMA[name];
    if (sh.getLastRow() === 0) {
      if (TEXT_SHEETS.indexOf(name) >= 0) {
        sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
      }
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8eef7');
      sh.setFrozenRows(1);
    }
  });
  seedIfEmpty_('設定', [
    ['LINE_CHANNEL_ID', '', 'LINE Login channel 的 Channel ID（見部署教學）'],
    ['開放天數', '30', '可直接預約的天數（含今天），更遠的日期走「遠期登記」']
  ]);
  seedIfEmpty_('師傅', SEED_MASTERS.map(function (n) { return [n, '是']; }));
  seedIfEmpty_('主任', SEED_CHIEFS.map(function (n) { return [n, '主任', '是', '', '', '']; }));
  seedIfEmpty_('工地', [['（範例）請改成實際工地', '其駿', '', '是']]);

  ['工作表1', 'Sheet1'].forEach(function (n) {
    var def = ss.getSheetByName(n);
    if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  });
  installTrigger_();
}

function seedIfEmpty_(name, rows) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (sh.getLastRow() > 1 || !rows.length) return;
  sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function installTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyJob') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyJob').timeBased().everyDays(1).atHour(0).nearMinute(5).inTimezone(TZ).create();
}

/** 每天凌晨自動執行：把進入 30 天內的遠期登記轉成正式預約 */
function dailyJob() {
  withLock_(function () { promoteFar_(); });
}

/* ───────────────────────── HTTP 入口 ───────────────────────── */

function doGet() {
  return json_({ ok: true, msg: '工班調度 API 運作中' });
}

function doPost(e) {
  var p = {};
  try { p = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { /* ignore */ }
  return json_(handle_(p));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

var ACTIONS = {
  init: function () { return ''; },
  bind: A_bind,
  book: A_book,
  edit: A_edit,
  transfer: A_transfer,
  release: A_release,
  farAdd: A_farAdd,
  farCancel: A_farCancel
};

function handle_(p) {
  try {
    var user = verify_(p.idToken);
    var fn = ACTIONS[p.action];
    if (!fn) fail_('未知的操作：' + p.action);
    return withLock_(function () {
      promoteFar_();
      var ctx = ctx_(user);
      if (p.action !== 'init' && p.action !== 'bind' && !ctx.me) fail_('請先選擇你的主任身分', 'UNBOUND');
      var msg = fn(p, ctx);
      return { ok: true, msg: msg || '', data: state_(ctx_(user)) };
    });
  } catch (err) {
    return { ok: false, error: err.message || String(err), code: err.code || '' };
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function fail_(msg, code) {
  var e = new Error(msg);
  e.code = code || '';
  throw e;
}

/* ───────────────────────── 身分驗證 ───────────────────────── */

function verify_(idToken) {
  if (!idToken) fail_('尚未登入 LINE', 'AUTH');
  var cache = CacheService.getScriptCache();
  var key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var channelId = setting_('LINE_CHANNEL_ID');
  if (!channelId) fail_('管理員尚未在試算表「設定」填入 LINE_CHANNEL_ID');
  var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: channelId },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) fail_('LINE 登入已過期，正在重新登入…', 'AUTH');
  var d = JSON.parse(res.getContentText());
  var user = { id: d.sub, name: d.name || '' };
  var ttl = d.exp ? Math.min(21600, Math.floor(d.exp - Date.now() / 1000) - 30) : 600;
  if (ttl > 0) cache.put(key, JSON.stringify(user), ttl);
  return user;
}

function ctx_(user) {
  var me = null;
  table_('主任').rows.forEach(function (r) {
    if (r.LINE_USER_ID && r.LINE_USER_ID === user.id && isOn_(r.啟用)) me = r;
  });
  return {
    user: user,
    me: me ? { name: me.名稱 } : null,
    isAdmin: !!(me && me.角色 === '管理員')
  };
}

/* ───────────────────────── 操作 ───────────────────────── */

function A_bind(p, ctx) {
  if (ctx.me) fail_('你已經綁定為「' + ctx.me.name + '」');
  var t = table_('主任');
  var row = find_(t.rows, function (r) { return r.名稱 === p.chief && isOn_(r.啟用); });
  if (!row) fail_('找不到主任「' + p.chief + '」');
  if (row.LINE_USER_ID) fail_('「' + row.名稱 + '」已經被其他 LINE 帳號綁定，請聯絡管理員');
  update_(t, row, { LINE_USER_ID: ctx.user.id, LINE名稱: ctx.user.name, 綁定時間: now_() });
  log_(row.名稱, '綁定身分', '', 'LINE 名稱：' + ctx.user.name);
  return '歡迎，' + row.名稱 + '！';
}

function A_book(p, ctx) {
  var b = buildBooking_(p, ctx, null);
  if (!inWindow_(b.日期)) {
    fail_('只能直接預約今天起 ' + openDays_() + ' 天內的日期，更遠的請用「遠期登記」');
  }
  var t = table_('預約');
  assertFree_(t.rows, b, null, ctx);
  var now = now_();
  b.ID = newId_('B');
  b.建立者 = ctx.me.name;
  b.建立時間 = now;
  b.更新時間 = now;
  append_(t, b);
  log_(ctx.me.name, '新增預約', b.ID, desc_(b));
  return '已預約：' + desc_(b);
}

function A_edit(p, ctx) {
  var t = table_('預約');
  var row = mustFind_(t.rows, p.id);
  assertCanModify_(row, ctx);
  var b = buildBooking_(p, ctx, row);
  if (b.日期 !== row.日期 && !inWindow_(b.日期)) {
    fail_('新日期必須在今天起 ' + openDays_() + ' 天內');
  }
  assertFree_(t.rows, b, row.ID, ctx);
  b.更新時間 = now_();
  var before = desc_(row);
  update_(t, row, b);
  log_(ctx.me.name, '修改預約', row.ID, before + ' → ' + desc_(b) + (b.備註 ? '｜備註：' + b.備註 : ''));
  return '已修改';
}

function A_transfer(p, ctx) {
  var t = table_('預約');
  var row = mustFind_(t.rows, p.id);
  assertCanModify_(row, ctx);
  var to = String(p.toChief || '').trim();
  if (activeNames_('主任').indexOf(to) < 0) fail_('找不到主任「' + to + '」');
  if (to === row.主任) fail_('這筆預約本來就是 ' + to + ' 的');
  var site = String(p.site || '').trim().slice(0, 60) || row.工地;
  var change = {
    主任: to,
    工地: site,
    自訂工地: activeNames_('工地').indexOf(site) < 0 ? '是' : '',
    備註: p.note !== undefined ? String(p.note).trim().slice(0, 200) : row.備註,
    更新時間: now_()
  };
  var from = row.主任;
  update_(t, row, change);
  log_(ctx.me.name, '轉讓', row.ID, from + ' → ' + to + '｜' + desc_(row));
  return '已轉讓給 ' + to;
}

function A_release(p, ctx) {
  var t = table_('預約');
  var row = mustFind_(t.rows, p.id);
  assertCanModify_(row, ctx);
  t.sh.deleteRow(row._row);
  log_(ctx.me.name, '釋出', row.ID, desc_(row));
  return '已釋出，這個時段現在是空的';
}

function A_farAdd(p, ctx) {
  var b = buildBooking_(p, ctx, null);
  var last = lastDay_();
  if (b.日期 <= last) fail_('這個日期已經在 ' + openDays_() + ' 天內，請直接在排班表預約');
  if (b.日期 > addDays_(today_(), 366)) fail_('最多只能登記一年內的日期');
  var t = table_('遠期登記');
  b.ID = newId_('F');
  b.登記時間 = now_();
  b.狀態 = '等待中';
  b.處理說明 = '';
  b.預約ID = '';
  append_(t, b);
  log_(ctx.me.name, '遠期登記', b.ID, desc_(b));
  return '已登記，進入 ' + openDays_() + ' 天內時會自動轉成正式預約';
}

function A_farCancel(p, ctx) {
  var t = table_('遠期登記');
  var row = mustFind_(t.rows, p.id);
  if (!ctx.isAdmin && row.主任 !== ctx.me.name) fail_('只有登記人或管理員可以取消');
  if (row.狀態 !== '等待中' && row.狀態 !== '衝突') fail_('這筆登記目前是「' + row.狀態 + '」，不能取消');
  update_(t, row, { 狀態: '已取消', 處理說明: ctx.me.name + ' 於 ' + now_() + ' 取消' });
  log_(ctx.me.name, '取消遠期登記', row.ID, desc_(row));
  return '已取消遠期登記';
}

/** 把已進入可預約範圍的遠期登記，依登記先後轉成正式預約 */
function promoteFar_() {
  var ft = table_('遠期登記');
  var today = today_();
  var last = lastDay_();
  var due = ft.rows.filter(function (r) { return r.狀態 === '等待中' && r.日期 <= last; });
  if (!due.length) return;
  due.sort(function (a, b) {
    return a.登記時間 < b.登記時間 ? -1 : a.登記時間 > b.登記時間 ? 1 : a._row - b._row;
  });
  var bt = table_('預約');
  var bookings = bt.rows.slice();
  due.forEach(function (r) {
    if (r.日期 < today) {
      update_(ft, r, { 狀態: '已過期', 處理說明: '日期已過' });
      return;
    }
    var clash = find_(bookings, function (x) {
      return x.日期 === r.日期 && x.師傅 === r.師傅 && overlap_(x.時段, r.時段);
    });
    if (clash) {
      var why = '與 ' + clash.主任 + ' 的預約衝突（' + clash.工地 + '，' + clash.時段 + '），請管理員協調';
      update_(ft, r, { 狀態: '衝突', 處理說明: why });
      log_('系統', '遠期轉正失敗', r.ID, desc_(r) + '｜' + why);
      return;
    }
    var now = now_();
    var b = {
      ID: newId_('B'), 日期: r.日期, 師傅: r.師傅, 時段: r.時段, 主任: r.主任, 工地: r.工地,
      自訂工地: r.自訂工地, 備註: r.備註, 建立者: r.主任 + '（遠期登記）', 建立時間: now, 更新時間: now
    };
    append_(bt, b);
    bookings.push(b);
    update_(ft, r, { 狀態: '已轉正', 預約ID: b.ID, 處理說明: now + ' 自動轉為正式預約' });
    log_('系統', '遠期轉正', b.ID, desc_(b));
  });
}

/* ───────────────────────── 回傳給前端的資料 ───────────────────────── */

function state_(ctx) {
  var today = today_();
  var from = addDays_(today, -7);
  var chiefRows = table_('主任').rows.filter(function (r) { return isOn_(r.啟用); });
  var logs = table_('紀錄').rows.slice(-50).reverse();
  return {
    user: { name: ctx.user.name },
    me: ctx.me ? { name: ctx.me.name, isAdmin: ctx.isAdmin } : null,
    today: today,
    days: openDays_(),
    lastDay: lastDay_(),
    masters: activeNames_('師傅'),
    chiefs: chiefRows.map(function (r) { return { name: r.名稱, bound: !!r.LINE_USER_ID }; }),
    sites: table_('工地').rows.filter(function (r) { return isOn_(r.啟用) && r.名稱; }).map(function (r) {
      return { name: r.名稱, chief: r.負責主任, address: r.地址 };
    }),
    bookings: table_('預約').rows.filter(function (r) { return r.日期 >= from; }).map(bookingOut_),
    far: table_('遠期登記').rows.filter(function (r) {
      return r.狀態 === '衝突' || (r.日期 >= today && r.狀態 !== '已過期');
    }).map(function (r) {
      var o = bookingOut_(r);
      o.registeredAt = r.登記時間; o.status = r.狀態; o.reason = r.處理說明; o.bookingId = r.預約ID;
      return o;
    }),
    logs: logs.map(function (r) {
      return { time: r.時間, actor: r.操作者, action: r.動作, content: r.內容 };
    })
  };
}

function bookingOut_(r) {
  return {
    id: r.ID, date: r.日期, master: r.師傅, slot: r.時段, chief: r.主任, site: r.工地,
    custom: r.自訂工地 === '是', note: r.備註, createdBy: r.建立者 || '',
    createdAt: r.建立時間 || '', updatedAt: r.更新時間 || ''
  };
}

/* ───────────────────────── 規則 ───────────────────────── */

function buildBooking_(p, ctx, base) {
  function pick(k, bk) {
    var v = p[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    return base ? base[bk] : '';
  }
  var date = pick('date', '日期');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail_('日期格式錯誤');
  var master = pick('master', '師傅');
  if (activeNames_('師傅').indexOf(master) < 0) fail_('找不到師傅「' + master + '」');
  var slot = pick('slot', '時段');
  if (SLOTS.indexOf(slot) < 0) fail_('時段只能是 全天／上午／下午');
  var chief = base ? base.主任 : ctx.me.name;
  if (ctx.isAdmin && p.chief) chief = String(p.chief).trim();
  if (activeNames_('主任').indexOf(chief) < 0) fail_('找不到主任「' + chief + '」');
  var site = pick('site', '工地').slice(0, 60);
  if (!site) fail_('請選擇或填寫工地');
  var note = (p.note !== undefined && p.note !== null ? String(p.note) : (base ? base.備註 : '')).trim().slice(0, 200);
  return {
    日期: date, 師傅: master, 時段: slot, 主任: chief, 工地: site,
    自訂工地: activeNames_('工地').indexOf(site) < 0 ? '是' : '', 備註: note
  };
}

function overlap_(a, b) {
  return a === '全天' || b === '全天' || a === b;
}

function assertFree_(rows, b, selfId, ctx) {
  var c = find_(rows, function (r) {
    return r.ID !== selfId && r.日期 === b.日期 && r.師傅 === b.師傅 && overlap_(r.時段, b.時段);
  });
  if (!c) return;
  var when = md_(b.日期) + ' ' + b.師傅 + (c.時段 === '全天' ? '' : c.時段);
  if (c.主任 === b.主任) fail_(when + ' 已經是 ' + c.主任 + ' 的預約（' + c.工地 + '）');
  fail_(when + ' 已被 ' + c.主任 + ' 預約（' + c.工地 + '）。請私下協調，談好後由 ' + c.主任 + ' 用「轉讓」改給你');
}

function assertCanModify_(row, ctx) {
  if (ctx.isAdmin) return;
  if (row.主任 !== ctx.me.name) fail_('只有 ' + row.主任 + ' 本人或管理員可以修改這筆預約');
  if (row.日期 < today_()) fail_('過去的預約只有管理員可以修改');
}

/* ───────────────────────── 工具 ───────────────────────── */

function table_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) fail_('找不到工作表「' + name + '」，請先執行 setup');
  var values = sh.getDataRange().getValues();
  var headers = (values[0] || []).map(function (h) { return String(h).trim(); });
  if (!headers.join('')) headers = SCHEMA[name];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (r.every(function (v) { return v === '' || v === null; })) continue;
    var o = { _row: i + 1 };
    headers.forEach(function (h, j) { o[h] = norm_(r[j], h); });
    rows.push(o);
  }
  return { sh: sh, headers: headers, rows: rows };
}

function norm_(v, h) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, h === '日期' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss');
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function append_(t, obj) {
  t.sh.appendRow(t.headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; }));
}

function update_(t, row, change) {
  var merged = merge_(row, change);
  t.sh.getRange(row._row, 1, 1, t.headers.length).setValues([
    t.headers.map(function (h) { return merged[h] !== undefined ? merged[h] : ''; })
  ]);
  Object.keys(change).forEach(function (k) { row[k] = change[k]; });
}

function merge_(a, b) {
  var o = {};
  Object.keys(a).forEach(function (k) { o[k] = a[k]; });
  Object.keys(b).forEach(function (k) { o[k] = b[k]; });
  return o;
}

function find_(rows, fn) {
  for (var i = 0; i < rows.length; i++) if (fn(rows[i])) return rows[i];
  return null;
}

function mustFind_(rows, id) {
  var r = find_(rows, function (x) { return x.ID === id; });
  if (!r) fail_('找不到這筆資料，可能已被別人修改，請重新整理');
  return r;
}

function activeNames_(name) {
  return table_(name).rows.filter(function (r) { return isOn_(r.啟用) && r.名稱; })
    .map(function (r) { return r.名稱; });
}

function isOn_(v) {
  var s = String(v).trim().toUpperCase();
  return s !== '否' && s !== 'FALSE' && s !== 'N' && s !== '0';
}

function setting_(key) {
  var r = find_(table_('設定').rows, function (x) { return x.項目 === key; });
  return r ? r.值 : '';
}

function openDays_() {
  var n = parseInt(setting_('開放天數'), 10);
  return n > 0 ? n : 30;
}

function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function lastDay_() { return addDays_(today_(), openDays_() - 1); }
function inWindow_(d) { return d >= today_() && d <= lastDay_(); }

function addDays_(ymd, n) {
  var p = ymd.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return d.toISOString().slice(0, 10);
}

function md_(ymd) {
  var p = ymd.split('-');
  var w = '日一二三四五六'.charAt(new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay());
  return (+p[1]) + '/' + (+p[2]) + '（' + w + '）';
}

function desc_(b) {
  return md_(b.日期) + ' ' + b.師傅 + ' ' + b.時段 + '｜' + b.工地 + '（' + b.主任 + '）';
}

function newId_(prefix) {
  return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase();
}

function log_(actor, action, id, content) {
  append_(table_('紀錄'), { 時間: now_(), 操作者: actor, 動作: action, ID: id, 內容: content });
}
