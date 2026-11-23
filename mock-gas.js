/*
 * 示範模式用：在瀏覽器裡模擬 Google 試算表 / Apps Script 環境，
 * 讓 apps-script/Code.js 的真實後端邏輯可以直接在網頁上跑（資料存在這台裝置的瀏覽器）。
 * 正式上線時不會用到這個檔案。
 */
(function () {
  var KEY = 'crew-demo-v1';
  var store = null;

  function load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* ignore */ } }

  function Range(sh, r, c, nr, nc) { this.sh = sh; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  Range.prototype.getValues = function () {
    var out = [];
    for (var i = 0; i < this.nr; i++) {
      var row = [];
      for (var j = 0; j < this.nc; j++) row.push(this.sh.cell(this.r + i, this.c + j));
      out.push(row);
    }
    return out;
  };
  Range.prototype.setValues = function (v) {
    var self = this;
    v.forEach(function (row, i) { row.forEach(function (x, j) { self.sh.set(self.r + i, self.c + j, x); }); });
    save();
    return this;
  };
  Range.prototype.setNumberFormat = function () { return this; };
  Range.prototype.setFontWeight = function () { return this; };
  Range.prototype.setBackground = function () { return this; };

  function Sheet(name) { this.name = name; }
  Sheet.prototype.rows = function () { return store.sheets[this.name]; };
  Sheet.prototype.cell = function (r, c) {
    var row = this.rows()[r - 1];
    return row && row[c - 1] !== undefined ? row[c - 1] : '';
  };
  Sheet.prototype.set = function (r, c, v) {
    var rows = this.rows();
    while (rows.length < r) rows.push([]);
    var row = rows[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = v;
  };
  Sheet.prototype.getName = function () { return this.name; };
  Sheet.prototype.getLastRow = function () { return this.rows().length; };
  Sheet.prototype.getLastColumn = function () {
    return this.rows().reduce(function (m, r) { return Math.max(m, r.length); }, 0);
  };
  Sheet.prototype.getMaxRows = function () { return 1000; };
  Sheet.prototype.getDataRange = function () {
    return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  };
  Sheet.prototype.getRange = function (r, c, nr, nc) { return new Range(this, r, c, nr || 1, nc || 1); };
  Sheet.prototype.appendRow = function (a) { this.rows().push(a.slice()); save(); return this; };
  Sheet.prototype.deleteRow = function (r) { this.rows().splice(r - 1, 1); save(); };
  Sheet.prototype.setFrozenRows = function () { };

  var ss = {
    getSheetByName: function (n) { return store.sheets[n] ? new Sheet(n) : null; },
    insertSheet: function (n) { store.sheets[n] = []; save(); return new Sheet(n); },
    getSheets: function () { return Object.keys(store.sheets).map(function (n) { return new Sheet(n); }); },
    deleteSheet: function (sh) { delete store.sheets[sh.name]; save(); },
    setSpreadsheetTimeZone: function () { }
  };

  window.SpreadsheetApp = { getActive: function () { return ss; } };
  window.LockService = { getScriptLock: function () { return { waitLock: function () { }, releaseLock: function () { } }; } };
  window.CacheService = { getScriptCache: function () { return { get: function () { return null; }, put: function () { } }; } };
  window.UrlFetchApp = {
    fetch: function (url, opt) {
      // 示範用假 token 格式：mock:<userId>:<LINE名稱>
      var parts = String(opt.payload.id_token).split(':');
      var ok = parts[0] === 'mock';
      return {
        getResponseCode: function () { return ok ? 200 : 400; },
        getContentText: function () { return JSON.stringify({ sub: parts[1], name: parts.slice(2).join(':') }); }
      };
    }
  };
  var trig = { timeBased: function () { return trig; }, everyDays: function () { return trig; }, atHour: function () { return trig; }, nearMinute: function () { return trig; }, inTimezone: function () { return trig; }, create: function () { } };
  window.ScriptApp = { getProjectTriggers: function () { return []; }, deleteTrigger: function () { }, newTrigger: function () { return trig; } };
  window.Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' },
    computeDigest: function (a, s) { return s; },
    base64EncodeWebSafe: function (s) { return s; },
    getUuid: function () {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function () { return (Math.random() * 16 | 0).toString(16); });
    },
    formatDate: function (date, tz, fmt) {
      var parts = {};
      new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).formatToParts(date).forEach(function (p) { parts[p.type] = p.value; });
      return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
        .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second);
    }
  };
  window.ContentService = { createTextOutput: function (s) { return { setMimeType: function () { return s; } }; }, MimeType: { JSON: 'json' } };

  var USERS = [
    { id: 'u1', name: '其駿', chief: '其駿' },
    { id: 'u2', name: '宇晉', chief: '宇晉' },
    { id: 'u3', name: '祺翊', chief: '祺翊' },
    { id: 'u4', name: '振宏', chief: '振宏' },
    { id: 'u5', name: '奕賢', chief: null },
    { id: 'u6', name: '老闆（示範）', chief: '老闆（示範）' }
  ];

  function token(u) { return 'mock:' + u.id + ':' + u.name; }

  function seed() {
    store = { sheets: {} };
    window.setup();
    var set = ss.getSheetByName('設定');
    set.getRange(2, 2).setValues([['demo']]);
    var sites = ss.getSheetByName('工地');
    sites.deleteRow(2);
    [['信義區住宅新建', '其駿', '台北市信義區', '是'], ['板橋透天整修', '宇晉', '新北市板橋區', '是'],
     ['新莊廠房', '祺翊', '新北市新莊區', '是'], ['內湖辦公室裝修', '振宏', '台北市內湖區', '是'],
     ['林口社區大樓', '奕賢', '新北市林口區', '是']].forEach(function (r) { sites.appendRow(r); });

    var chiefs = ss.getSheetByName('主任');
    chiefs.appendRow(['老闆（示範）', '主任', '是', '', '', '']);
    USERS.forEach(function (u) { if (u.chief) window.handle_({ action: 'bind', idToken: token(u), chief: u.chief }); });
    chiefs.getRange(2, 2).setValues([['管理員']]);
    chiefs.getRange(7, 2).setValues([['老闆']]);

    var today = window.today_();
    var d = function (n) { return window.addDays_(today, n); };
    var book = function (ui, data) { window.handle_(Object.assign({ action: 'book', idToken: token(USERS[ui]) }, data)); };
    book(0, { date: d(0), master: '阿得', slot: '全天', site: '信義區住宅新建' });
    book(1, { date: d(0), master: '阿佑', slot: '上午', site: '板橋透天整修', note: '拆除' });
    book(2, { date: d(0), master: '阿佑', slot: '下午', site: '新莊廠房' });
    book(3, { date: d(0), master: '小安', slot: '全天', site: '內湖辦公室裝修' });
    book(0, { date: d(1), master: '阿得', slot: '全天', site: '信義區住宅新建', note: '灌漿' });
    book(1, { date: d(1), master: '小安', slot: '全天', site: '板橋透天整修' });
    book(2, { date: d(2), master: '阿佑', slot: '全天', site: '新莊廠房' });
    book(3, { date: d(3), master: '阿得', slot: '全天', site: '大安區保固（王先生）' });
    book(1, { date: d(5), master: '小安', slot: '全天', site: '板橋透天整修' });
    window.handle_({ action: 'farAdd', idToken: token(USERS[2]), date: d(40), master: '阿得', slot: '全天', site: '新莊廠房', note: '二期' });
    save();
  }

  window.DemoBackend = {
    users: USERS,
    token: token,
    ensure: function () { store = load(); if (!store || !store.sheets) seed(); },
    reset: function () { try { localStorage.removeItem(KEY); } catch (e) { } seed(); },
    call: function (p) { return JSON.parse(JSON.stringify(window.handle_(p))); }
  };
})();
