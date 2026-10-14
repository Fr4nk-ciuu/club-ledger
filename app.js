/* 社团经费与报销台账 - 核心逻辑 */
(function () {
  'use strict';

  var STORE_KEY = 'club-ledger-v1';
  var STATUS_TEXT = { none: '不涉及报销', pending: '待报销', approved: '已审核', reimbursed: '已报销', rejected: '已驳回' };

  // ---------- 数据 ----------
  var db = load();
  var editingId = null; // 正在编辑的记录 id

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* 忽略损坏数据 */ }
    return { records: [], budgets: [], seq: 1 };
  }
  function save() { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }

  function fmt(n) { return '¥' + Number(n).toFixed(2); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function byId(id) { return document.getElementById(id); }

  // 收据文件以 DataURL 存入 localStorage(小文件场景)
  function readFiles(files, cb) {
    var out = [], left = files.length;
    if (!left) return cb(out);
    Array.prototype.forEach.call(files, function (f) {
      var r = new FileReader();
      r.onload = function () {
        out.push({ name: f.name, url: r.result });
        if (--left === 0) cb(out);
      };
      r.readAsDataURL(f);
    });
  }

  // ---------- 台账渲染 ----------
  function filteredRecords() {
    var kw = byId('search').value.trim();
    var type = byId('filter-type').value;
    var act = byId('filter-activity').value;
    return db.records.filter(function (r) {
      if (type && r.type !== type) return false;
      if (act && r.activity !== act) return false;
      if (kw && (r.memo + r.activity).indexOf(kw) === -1) return false;
      return true;
    }).sort(function (a, b) { return b.date.localeCompare(a.date) || b.id - a.id; });
  }

  function renderLedger() {
    var rows = filteredRecords();
    var tbody = byId('ledger-body');
    tbody.innerHTML = rows.map(function (r) {
      var amt = r.type === 'income'
        ? '<span class="amount-income">+' + fmt(r.amount) + '</span>'
        : '<span class="amount-expense">-' + fmt(r.amount) + '</span>';
      var receipts = (r.receipts || []).map(function (rc, i) {
        return '<a href="' + rc.url + '" target="_blank" title="' + esc(rc.name) + '">票' + (i + 1) + '</a>';
      }).join(' ');
      return '<tr data-id="' + r.id + '">' +
        '<td>' + esc(r.date) + '</td>' +
        '<td>' + (r.type === 'income' ? '收入' : '支出') + '</td>' +
        '<td>' + esc(r.activity) + '</td>' +
        '<td>' + esc(r.memo) + '</td>' +
        '<td class="num">' + amt + '</td>' +
        '<td>' + (receipts || '—') + '</td>' +
        '<td><span class="badge ' + r.status + '">' + STATUS_TEXT[r.status] + '</span></td>' +
        '<td><button class="btn-link act-edit">编辑</button>' +
        '<button class="btn-link danger act-del">删除</button></td></tr>';
    }).join('');
    byId('ledger-empty').hidden = rows.length > 0;

    // 汇总
    var inc = 0, exp = 0, pend = 0;
    db.records.forEach(function (r) {
      if (r.type === 'income') inc += r.amount; else exp += r.amount;
      if (r.status === 'pending' && r.type === 'expense') pend += r.amount;
    });
    byId('sum-income').textContent = fmt(inc);
    byId('sum-expense').textContent = fmt(exp);
    byId('sum-balance').textContent = fmt(inc - exp);
    byId('sum-pending').textContent = fmt(pend);

    // 活动下拉与 datalist
    var acts = uniqueActivities();
    fillSelect(byId('filter-activity'), acts, '全部活动');
    byId('activity-list').innerHTML = acts.map(function (a) {
      return '<option value="' + esc(a) + '">';
    }).join('');

    renderReports();
    renderBudget();
  }

  function uniqueActivities() {
    var seen = {};
    db.records.forEach(function (r) { seen[r.activity] = 1; });
    db.budgets.forEach(function (b) { seen[b.name] = 1; });
    return Object.keys(seen);
  }

  function fillSelect(sel, items, allLabel) {
    var cur = sel.value;
    sel.innerHTML = '<option value="">' + allLabel + '</option>' +
      items.map(function (a) { return '<option value="' + esc(a) + '">' + esc(a) + '</option>'; }).join('');
    if (items.indexOf(cur) !== -1) sel.value = cur;
  }

  // ---------- 报销管理 ----------
  function renderReports() {
    var rows = db.records.filter(function (r) { return r.status !== 'none'; })
      .sort(function (a, b) { return b.id - a.id; });
    var tbody = byId('report-body');
    tbody.innerHTML = rows.map(function (r) {
      var next = { pending: 'approved', approved: 'reimbursed' }[r.status];
      var actions = '';
      if (next) actions += '<button class="btn-link act-advance" data-next="' + next + '">标记为' + STATUS_TEXT[next] + '</button>';
      if (r.status === 'pending') actions += '<button class="btn-link danger act-reject">驳回</button>';
      return '<tr data-id="' + r.id + '">' +
        '<td>' + esc(r.applicant || '—') + '</td>' +
        '<td>' + esc(r.activity) + '</td>' +
        '<td>' + esc(r.memo) + '</td>' +
        '<td class="num">' + fmt(r.amount) + '</td>' +
        '<td>' + (r.receipts ? r.receipts.length : 0) + '</td>' +
        '<td><span class="badge ' + r.status + '">' + STATUS_TEXT[r.status] + '</span></td>' +
        '<td>' + (actions || '—') + '</td></tr>';
    }).join('');
    byId('report-empty').hidden = rows.length > 0;
  }

  // ---------- 预算核对 ----------
  function renderBudget() {
    var tbody = byId('budget-body');
    tbody.innerHTML = db.budgets.map(function (b) {
      var inc = 0, exp = 0;
      db.records.forEach(function (r) {
        if (r.activity !== b.name) return;
        if (r.type === 'income') inc += r.amount; else exp += r.amount;
      });
      var dev = exp - b.amount;
      var pct = b.amount > 0 ? Math.min(100, Math.round(exp / b.amount * 100)) : 0;
      var status = b.amount === 0 ? '<span class="badge none">未设预算</span>'
        : dev > 0 ? '<span class="badge over">超支 ' + fmt(dev) + '</span>'
        : '<span class="badge ok">剩余 ' + fmt(-dev) + '</span>';
      return '<tr>' +
        '<td>' + esc(b.name) + '</td>' +
        '<td class="num">' + fmt(b.amount) + '</td>' +
        '<td class="num amount-income">' + fmt(inc) + '</td>' +
        '<td class="num amount-expense">' + fmt(exp) + '</td>' +
        '<td class="num" style="color:' + (dev > 0 ? 'var(--expense)' : 'var(--income)') + '">' + (dev > 0 ? '+' : '') + fmt(dev) + '</td>' +
        '<td><span class="progress"><div style="width:' + pct + '%"></div></span> ' + pct + '%</td>' +
        '<td>' + status + '</td>' +
        '<td><button class="btn-link danger act-del-budget" data-name="' + esc(b.name) + '">删除</button></td></tr>';
    }).join('');
    byId('budget-empty').hidden = db.budgets.length > 0;
  }

  // ---------- 记录对话框 ----------
  function openRecordDialog(rec) {
    editingId = rec ? rec.id : null;
    byId('dlg-record-title').textContent = rec ? '编辑记录' : '新增记录';
    byId('f-date').value = rec ? rec.date : new Date().toISOString().slice(0, 10);
    byId('f-type').value = rec ? rec.type : 'expense';
    byId('f-activity').value = rec ? rec.activity : '';
    byId('f-memo').value = rec ? rec.memo : '';
    byId('f-amount').value = rec ? rec.amount : '';
    byId('f-status').value = rec ? rec.status : 'none';
    byId('f-applicant').value = rec ? (rec.applicant || '') : '';
    byId('f-receipts').value = '';
    renderExistingReceipts(rec ? rec.receipts || [] : []);
    byId('dlg-record').showModal();
  }

  function renderExistingReceipts(list) {
    byId('receipt-list').innerHTML = list.map(function (rc, i) {
      return '<span class="receipt-item"><a href="' + rc.url + '" target="_blank">' + esc(rc.name) + '</a>' +
        '<button type="button" class="btn-link danger" data-rm="' + i + '">✕</button></span>';
    }).join('');
  }

  function collectFormReceipts(existing) {
    return new Promise(function (resolve) {
      var files = byId('f-receipts').files;
      readFiles(files, function (added) { resolve(existing.concat(added)); });
    });
  }

  // ---------- 事件绑定 ----------
  // 标签页
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      byId('tab-' + t.dataset.tab).classList.add('active');
    });
  });

  // 新增/编辑记录
  byId('btn-add').addEventListener('click', function () { openRecordDialog(null); });

  var pendingReceipts = []; // 对话框中已保留的票据
  var _renderExisting = renderExistingReceipts;
  renderExistingReceipts = function (list) {
    pendingReceipts = list.slice();
    _renderExisting(list);
  };
  byId('receipt-list').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-rm]');
    if (!btn) return;
    pendingReceipts.splice(Number(btn.dataset.rm), 1);
    _renderExisting(pendingReceipts);
  });

  byId('form-record').addEventListener('submit', function (e) {
    e.preventDefault();
    collectFormReceipts(pendingReceipts).then(function (receipts) {
      var rec = {
        id: editingId || db.seq++,
        date: byId('f-date').value,
        type: byId('f-type').value,
        activity: byId('f-activity').value.trim(),
        memo: byId('f-memo').value.trim(),
        amount: Number(byId('f-amount').value),
        status: byId('f-status').value,
        applicant: byId('f-applicant').value.trim(),
        receipts: receipts
      };
      if (editingId) {
        var idx = db.records.findIndex(function (r) { return r.id === editingId; });
        db.records[idx] = rec;
      } else {
        db.records.push(rec);
      }
      save();
      byId('dlg-record').close();
      renderLedger();
    });
  });
  byId('btn-cancel-record').addEventListener('click', function () { byId('dlg-record').close(); });

  // 台账操作(编辑/删除)
  byId('ledger-body').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    var id = Number(tr.dataset.id);
    var rec = db.records.find(function (r) { return r.id === id; });
    if (e.target.classList.contains('act-edit')) openRecordDialog(rec);
    if (e.target.classList.contains('act-del') && confirm('确认删除这条记录?')) {
      db.records = db.records.filter(function (r) { return r.id !== id; });
      save(); renderLedger();
    }
  });

  // 报销操作
  byId('report-body').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    var id = Number(tr.dataset.id);
    var rec = db.records.find(function (r) { return r.id === id; });
    if (!rec) return;
    if (e.target.classList.contains('act-advance')) { rec.status = e.target.dataset.next; }
    if (e.target.classList.contains('act-reject')) { rec.status = 'rejected'; }
    save(); renderLedger();
  });

  // 筛选
  ['search', 'filter-type', 'filter-activity'].forEach(function (id) {
    byId(id).addEventListener('input', renderLedger);
  });

  // ---------- 预算 ----------
  byId('btn-add-budget').addEventListener('click', function () { byId('dlg-budget').showModal(); });
  byId('btn-cancel-budget').addEventListener('click', function () { byId('dlg-budget').close(); });
  byId('form-budget').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = byId('b-name').value.trim();
    var amount = Number(byId('b-amount').value);
    var exist = db.budgets.find(function (b) { return b.name === name; });
    if (exist) exist.amount = amount; else db.budgets.push({ name: name, amount: amount });
    save();
    byId('dlg-budget').close();
    renderBudget();
  });
  byId('budget-body').addEventListener('click', function (e) {
    var btn = e.target.closest('.act-del-budget');
    if (!btn || !confirm('确认删除该活动预算?')) return;
    db.budgets = db.budgets.filter(function (b) { return b.name !== btn.dataset.name; });
    save(); renderBudget();
  });

  // ---------- CSV 导入/导出 ----------
  function csvEscape(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }
  byId('btn-export').addEventListener('click', function () {
    var head = ['日期', '类型', '活动', '摘要', '金额', '报销状态', '申请人', '票据数'];
    var lines = [head.join(',')].concat(db.records.map(function (r) {
      return [r.date, r.type, r.activity, r.memo, r.amount, STATUS_TEXT[r.status], r.applicant || '', (r.receipts || []).length]
        .map(csvEscape).join(',');
    }));
    var blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '社团经费台账.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  byId('btn-import').addEventListener('click', function () { byId('file-import').click(); });
  byId('file-import').addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      var lines = r.result.replace(/^\ufeff/, '').split(/\r?\n/).slice(1).filter(Boolean);
      lines.forEach(function (line) {
        var cols = line.match(/("([^"]|"")*"|[^,]*)/g).filter(function (_, i) { return i % 2 === 0; }).slice(0, 8)
          .map(function (c) { return c.replace(/^"|"$/g, '').replace(/""/g, '"'); });
        if (cols.length < 5) return;
        var statusText = cols[5] || '不涉及报销';
        var status = Object.keys(STATUS_TEXT).find(function (k) { return STATUS_TEXT[k] === statusText; }) || 'none';
        db.records.push({
          id: db.seq++,
          date: cols[0], type: cols[1] === '收入' ? 'income' : 'expense',
          activity: cols[2], memo: cols[3],
          amount: Number(cols[4]) || 0,
          status: status, applicant: cols[6] || '', receipts: []
        });
      });
      save(); renderLedger();
      byId('file-import').value = '';
    };
    r.readAsText(f, 'utf-8');
  });

  // ---------- 启动 ----------
  renderLedger();
})();
