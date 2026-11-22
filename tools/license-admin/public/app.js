/* 授权管理工具前端：无构建步骤，直接和本地管理接口通信。 */
(() => {
  const THEME_KEY = 'tuku-admin-theme';
  const params = new URLSearchParams(location.search);
  let token = params.get('token') || sessionStorage.getItem('tuku-admin-token') || '';
  if (params.get('token')) {
    sessionStorage.setItem('tuku-admin-token', params.get('token'));
    history.replaceState({}, '', location.pathname);
  }

  let state = null;
  let created = [];
  let activeFilter = '';
  let revokedFilter = '';

  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function toast(message, kind = 'info') {
    const box = $('toast');
    box.textContent = message;
    box.className = `toast ${kind === 'error' ? 'error' : ''}`;
    box.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      box.hidden = true;
    }, 3600);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('已复制到剪贴板');
  }

  function download(name, text, type = 'text/plain') {
    const blob = new Blob([text], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
    if (res.status === 401) {
      showTokenBar(true);
      throw new Error('访问令牌不正确');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function showTokenBar(show) {
    $('tokenBar').hidden = !show;
    if (show) $('tokenInput').focus();
  }

  async function load({ quiet = false } = {}) {
    if (!token) {
      showTokenBar(true);
      return;
    }
    try {
      const data = await api('/api/state');
      state = data;
      showTokenBar(false);
      render();
    } catch (err) {
      if (!quiet) toast(err.message, 'error');
    }
  }

  /* ------------------------------ 主题 ------------------------------ */

  function applyTheme(value) {
    const theme = ['light', 'dark', 'system'].includes(value) ? value : 'system';
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    document.querySelectorAll('#themeSwitch button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeValue === theme);
    });
  }

  /* ------------------------------ 渲染 ------------------------------ */

  const statusLabel = { active: '有效', expired: '已过期', revoked: '已停用' };
  const revokedByLabel = { pair: '已取消授权', phone: '手机号停用', machine: '设备停用' };
  const fmtDevice = (value) => {
    const v = String(value ?? '').toUpperCase();
    return /^[0-9A-F]{24}$/.test(v) ? `TK2-${v.match(/.{4}/g).join('-')}` : v;
  };

  function render() {
    if (!state) return;
    const s = state.summary;

    $('keyState').textContent = state.keyReady ? '私钥已加载' : '未找到私钥';
    $('keyState').className = `pill ${state.keyReady ? 'ok' : 'bad'}`;

    $('stats').innerHTML = [
      ['有效', s.active, '条'],
      ['已停用', s.revoked, '条'],
      ['7 天内到期', s.expiring7, '条'],
      ['手机号', s.phones, '个'],
      ['授权记录', s.records, '条'],
    ]
      .map(
        ([label, num, suffix]) =>
          `<div class="stat"><div class="num">${esc(num)}</div><div class="label">${esc(label)} · ${esc(suffix)}</div></div>`
      )
      .join('');

    $('issueBtn').disabled = !state.keyReady;
    $('batchIssueBtn').disabled = !state.keyReady;
    $('activeCount').textContent = `${s.active} 有效${s.expired ? ` · ${s.expired} 过期` : ''}`;
    $('revokedCount').textContent = `${s.revoked} 条`;

    renderActiveTable();
    renderRevokedTable();
    renderLegacyRevokes();
    renderManifest();
    updateSelectionButtons();
  }

  function matches(row, query) {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [row.phone, row.machine, row.note].some((v) => String(v ?? '').toLowerCase().includes(q));
  }

  function expiryCell(row) {
    const expiry = row.expires ? esc(row.expires) : '永久';
    const left = row.status === 'expired' ? '已过期' : row.daysLeft != null ? `剩 ${row.daysLeft} 天` : '';
    return `<td class="nowrap">${expiry}${left ? `<div class="hint">${esc(left)}</div>` : ''}</td>`;
  }

  function renderActiveTable() {
    const box = $('activeTable');
    const rows = (state?.licenses || []).filter((x) => x.status !== 'revoked' && matches(x, activeFilter));
    if (!rows.length) {
      box.innerHTML = `<div class="empty-row">${state?.licenses?.length ? '没有匹配的授权。' : '还没有授权记录，先到「授权」页签发。'}</div>`;
      return;
    }
    box.innerHTML = `<table>
      <thead><tr>
        <th class="col-check"><input type="checkbox" data-select-all="active" aria-label="全选" /></th>
        <th>手机号 / 备注</th><th>设备码</th><th>状态</th><th>签发</th><th>到期</th><th>操作</th>
      </tr></thead>
      <tbody>${rows
        .map(
          (x) => `<tr>
            <td class="col-check"><input type="checkbox" data-row="active" data-id="${esc(x.id)}" aria-label="选择" /></td>
            <td><div class="phone">${esc(x.phone)}</div>${x.note ? `<div class="hint">${esc(x.note)}</div>` : ''}</td>
            <td class="mono">${esc(x.machine)}${x.deviceVersion === 1 ? '<div class="hint">旧版 16 位</div>' : ''}</td>
            <td><span class="badge ${esc(x.status)}">${esc(statusLabel[x.status] || x.status)}</span></td>
            <td class="nowrap">${esc(x.issuedAt)}</td>
            ${expiryCell(x)}
            <td class="actions">
              <button class="btn sm" data-action="copy-key" data-id="${esc(x.id)}">复制</button>
              <button class="btn sm danger" data-action="cancel" data-id="${esc(x.id)}">取消授权</button>
            </td>
          </tr>`
        )
        .join('')}</tbody>
    </table>`;
  }

  function renderRevokedTable() {
    const box = $('revokedTable');
    const rows = (state?.licenses || []).filter((x) => x.status === 'revoked' && matches(x, revokedFilter));
    if (!rows.length) {
      box.innerHTML = '<div class="empty-row">没有已停用的授权。</div>';
      return;
    }
    box.innerHTML = `<table>
      <thead><tr>
        <th class="col-check"><input type="checkbox" data-select-all="revoked" aria-label="全选" /></th>
        <th>手机号 / 备注</th><th>设备码</th><th>停用原因</th><th>签发</th><th>到期</th><th>操作</th>
      </tr></thead>
      <tbody>${rows
        .map(
          (x) => `<tr>
            <td class="col-check"><input type="checkbox" data-row="revoked" data-id="${esc(x.id)}" aria-label="选择" /></td>
            <td><div class="phone">${esc(x.phone)}</div>${x.note ? `<div class="hint">${esc(x.note)}</div>` : ''}</td>
            <td class="mono">${esc(x.machine)}${x.deviceVersion === 1 ? '<div class="hint">旧版 16 位</div>' : ''}</td>
            <td><span class="badge revoked">${esc(revokedByLabel[x.revokedBy] || '已停用')}</span></td>
            <td class="nowrap">${esc(x.issuedAt)}</td>
            ${expiryCell(x)}
            <td class="actions">
              <button class="btn sm" data-action="copy-key" data-id="${esc(x.id)}">复制</button>
              <button class="btn sm primary" data-action="restore" data-id="${esc(x.id)}">恢复授权</button>
            </td>
          </tr>`
        )
        .join('')}</tbody>
    </table>`;
  }

  function renderLegacyRevokes() {
    const phones = state.revocations?.phones || [];
    const machines = state.revocations?.machines || [];
    $('legacyRevokes').hidden = !phones.length && !machines.length;
    $('revokedPhoneList').innerHTML = phones.length
      ? phones
          .map(
            (p) =>
              `<span class="chip">${esc(p)}<button data-action="unrevoke-phone" data-values="${esc(p)}" title="解除停用">恢复</button></span>`
          )
          .join('')
      : '<span class="hint">暂无</span>';
    $('revokedMachineList').innerHTML = machines.length
      ? machines
          .map(
            (m) =>
              `<span class="chip">${esc(fmtDevice(m))}<button data-action="unrevoke-machine" data-values="${esc(m)}" title="解除停用">恢复</button></span>`
          )
          .join('')
      : '<span class="hint">暂无</span>';
  }

  function renderManifest() {
    const tokenText = state.manifest?.token || '';
    $('manifestSeq').textContent = `seq ${state.seq}`;
    $('manifestPath').textContent = state.admin.manifestFile;
    $('manifestUrl').textContent = state.admin.manifestUrl;
    $('publishPath').textContent = state.admin.publishFile || '（未找到仓库发布文件）';
    $('publishUrl').textContent = state.admin.publishUrl || '';
    $('manifestText').value = tokenText || '（还没有停用记录；取消授权后自动生成签名清单）';
    $('copyManifest').disabled = !tokenText;
    $('downloadManifest').disabled = !tokenText;
    $('publishFile').disabled = !tokenText || !state.admin.publishFile;
  }

  function renderIssueResult(list) {
    if (!list?.length) return;
    $('issueResult').className = 'result';
    $('issueResult').innerHTML = list
      .map(
        (x) => `<div class="key-item">
          <div class="meta"><span>${esc(x.phone)} · ${esc(x.machine)}</span><span>${esc(x.expires || '永久')}</span></div>
          <div class="key">${esc(x.key)}</div>
          <button class="btn sm" data-action="copy-key" data-id="${esc(x.id)}">复制这个授权码</button>
        </div>`
      )
      .join('');
    $('copyCreated').disabled = false;
    $('downloadCreated').disabled = false;
  }

  /* ------------------------------ 选择 / 操作 ------------------------------ */

  function selectedIds(group) {
    return [...document.querySelectorAll(`#${group}Table input[data-row="${group}"]:checked`)].map((el) => el.dataset.id);
  }

  function updateSelectionButtons() {
    const active = selectedIds('active').length;
    const revoked = selectedIds('revoked').length;
    $('cancelSelected').disabled = !state?.keyReady || !active;
    $('cancelSelected').textContent = active ? `取消选中授权（${active}）` : '取消选中授权';
    $('restoreSelected').disabled = !state?.keyReady || !revoked;
    $('restoreSelected').textContent = revoked ? `恢复选中授权（${revoked}）` : '恢复选中授权';
    document.querySelectorAll('input[data-select-all]').forEach((el) => {
      const group = el.dataset.selectAll;
      const boxes = [...document.querySelectorAll(`#${group}Table input[data-row="${group}"]`)];
      el.checked = boxes.length > 0 && boxes.every((box) => box.checked);
      el.indeterminate = boxes.some((box) => box.checked) && !el.checked;
    });
  }

  async function cancelRecords(ids) {
    if (!ids.length) return;
    if (!confirm(`确定取消选中的 ${ids.length} 条授权？\n\n只会停用对应的「手机号 + 设备码」，同一台设备上的其他手机号不受影响。`)) return;
    try {
      const data = await api('/api/cancel', { method: 'POST', body: JSON.stringify({ ids }) });
      state = data.state;
      render();
      toast(data.changed ? `已取消 ${ids.length} 条授权` : '这些授权已经停用');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function restoreRecords(ids) {
    if (!ids.length) return;
    if (
      !confirm(
        `确定恢复选中的 ${ids.length} 条授权？\n\n如果该手机号或设备之前被整体停用，恢复后它们名下的所有授权都会一起恢复。`
      )
    )
      return;
    try {
      const data = await api('/api/restore', { method: 'POST', body: JSON.stringify({ ids }) });
      state = data.state;
      render();
      toast(data.changed ? `已恢复 ${ids.length} 条授权` : '这些授权已经恢复');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function revokeScope(scope, value, revoked) {
    const label = scope === 'phone' ? '手机号' : '设备';
    const verb = revoked ? '停用' : '恢复';
    if (!confirm(`确定${verb}${label}「${fmtDevice(value) || value}」？\n\n这会影响该${label}名下的所有授权。`)) return false;
    try {
      const data = await api('/api/revoke', {
        method: 'POST',
        body: JSON.stringify({ scope, value, revoked }),
      });
      state = data.state;
      render();
      toast(`${label}已${verb}${data.changed ? '' : '（无变化）'}`);
      return true;
    } catch (err) {
      toast(err.message, 'error');
      return false;
    }
  }

  /* ------------------------------ 签发 ------------------------------ */

  function readValidity(prefix) {
    const mode = $(`${prefix}Days`).value;
    if (mode === 'custom') {
      const expires = $(`${prefix}Expires`).value;
      return expires ? { expires } : { error: '请选择到期日' };
    }
    return { days: Number(mode) };
  }

  function parsePairLine(line) {
    const raw = String(line ?? '').trim();
    if (!raw) return null;
    const match = raw.match(/(?:TK2[-\s]?)?(?:[0-9A-Fa-f]{4}[-\s]?){5}[0-9A-Fa-f]{4}/);
    if (!match) return null;
    return {
      phone: raw.replace(match[0], ' ').replace(/[^\d+]/g, ''),
      machine: match[0],
    };
  }

  async function submitIssue(button, path, body, onDone) {
    const btn = $(button);
    btn.disabled = true;
    try {
      const data = await api(path, { method: 'POST', body: JSON.stringify(body) });
      state = data.state;
      created = data.created || [];
      render();
      renderIssueResult(created);
      onDone?.();
      toast(`已生成 ${created.length} 个授权码`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = !state?.keyReady;
    }
  }

  /* ------------------------------ 事件绑定 ------------------------------ */

  $('tokenSave').addEventListener('click', () => {
    const value = $('tokenInput').value.trim();
    if (!value) return toast('请先粘贴访问令牌', 'error');
    token = value;
    sessionStorage.setItem('tuku-admin-token', token);
    void load();
  });
  $('tokenInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('tokenSave').click();
  });

  $('reload').addEventListener('click', () => void load());

  document.querySelectorAll('#themeSwitch button').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeValue));
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      for (const name of ['issue', 'active', 'revoked']) {
        $(`tab-${name}`).hidden = tab.dataset.tab !== name;
      }
      updateSelectionButtons();
    });
  });

  for (const prefix of ['single', 'batch']) {
    $(`${prefix}Days`).addEventListener('change', () => {
      $(`${prefix}ExpiresField`).hidden = $(`${prefix}Days`).value !== 'custom';
    });
  }

  $('activeSearch').addEventListener('input', () => {
    activeFilter = $('activeSearch').value;
    renderActiveTable();
    updateSelectionButtons();
  });
  $('revokedSearch').addEventListener('input', () => {
    revokedFilter = $('revokedSearch').value;
    renderRevokedTable();
    updateSelectionButtons();
  });

  $('singleForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state?.keyReady) return toast('未找到授权私钥，无法签发', 'error');
    const phone = $('singlePhone').value.trim();
    const machine = $('singleMachine').value.trim();
    if (!phone) return toast('请填写手机号', 'error');
    if (!machine) return toast('请填写设备码', 'error');
    const validity = readValidity('single');
    if (validity.error) return toast(validity.error, 'error');
    void submitIssue(
      'issueBtn',
      '/api/issue',
      { phone, machine, note: $('singleNote').value.trim(), ...validity, edition: 'pro' },
      () => {
        $('singleMachine').value = '';
      }
    );
  });

  $('batchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state?.keyReady) return toast('未找到授权私钥，无法签发', 'error');
    const lines = $('batchPairs').value.split(/\r?\n/);
    const pairs = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const pair = parsePairLine(lines[i]);
      if (!pair) return toast(`第 ${i + 1} 行格式不正确，应为「手机号 + 设备码」`, 'error');
      if (!pair.phone) return toast(`第 ${i + 1} 行缺少手机号`, 'error');
      pairs.push(pair);
    }
    if (!pairs.length) return toast('请至少填写一条「手机号 + 设备码」', 'error');
    const validity = readValidity('batch');
    if (validity.error) return toast(validity.error, 'error');
    void submitIssue(
      'batchIssueBtn',
      '/api/issue-batch',
      { pairs, note: $('batchNote').value.trim(), ...validity, edition: 'pro' },
      () => {
        $('batchPairs').value = '';
      }
    );
  });

  $('cancelSelected').addEventListener('click', () => void cancelRecords(selectedIds('active')));
  $('restoreSelected').addEventListener('click', () => void restoreRecords(selectedIds('revoked')));
  $('revokePhoneBtn').addEventListener('click', async () => {
    const input = $('revokePhone');
    const value = input.value.trim();
    if (!value) return toast('请填写要停用的手机号', 'error');
    if (await revokeScope('phone', value, true)) input.value = '';
  });

  $('importLegacy').addEventListener('click', async () => {
    try {
      const data = await api('/api/import-legacy', { method: 'POST', body: '{}' });
      state = data.state;
      render();
      toast(`扫描 ${data.files} 个文件，导入 ${data.added} 条，跳过 ${data.skipped} 条`);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('copyCreated').addEventListener('click', () => {
    const text = created.map((x) => `${x.phone}\t${x.machine}\t${x.expires || '永久'}\t${x.key}`).join('\n');
    if (text) void copy(text);
  });
  $('downloadCreated').addEventListener('click', () => {
    if (!created.length) return;
    const text = created.map((x) => `${x.phone}\t${x.machine}\t${x.expires || '永久'}\n${x.key}`).join('\n\n');
    download(`license-keys-${new Date().toISOString().slice(0, 10)}.txt`, text);
  });

  $('copyManifest').addEventListener('click', () => {
    if (state?.manifest?.token) void copy(state.manifest.token);
  });
  $('copyManifestUrl').addEventListener('click', () => {
    if (state?.admin?.manifestUrl) void copy(state.admin.manifestUrl);
  });
  $('copyPublishUrl').addEventListener('click', () => {
    if (state?.admin?.publishUrl) void copy(state.admin.publishUrl);
  });
  $('publishFile').addEventListener('click', async () => {
    try {
      const data = await api('/api/publish', { method: 'POST', body: '{}' });
      toast(`已写入 ${data.file}，请 git commit && git push`);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('downloadManifest').addEventListener('click', () => {
    if (state?.manifest?.token) {
      download('license-revoke.json', JSON.stringify({ token: state.manifest.token }, null, 2), 'application/json');
    }
  });

  // 表格 / 结果区 / 停用 chip 共用事件委托
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const value = btn.dataset.values;
    if (action === 'copy-key') {
      const rec = state.licenses.find((x) => x.id === id);
      if (rec) void copy(rec.key);
    } else if (action === 'cancel') {
      void cancelRecords([id]);
    } else if (action === 'restore') {
      void restoreRecords([id]);
    } else if (action === 'unrevoke-phone') {
      void revokeScope('phone', value, false);
    } else if (action === 'unrevoke-machine') {
      void revokeScope('machine', value, false);
    }
  });

  document.addEventListener('change', (event) => {
    const all = event.target.closest('input[data-select-all]');
    if (all) {
      const group = all.dataset.selectAll;
      document.querySelectorAll(`#${group}Table input[data-row="${group}"]`).forEach((box) => {
        box.checked = all.checked;
      });
      updateSelectionButtons();
      return;
    }
    if (event.target.matches('input[data-row]')) updateSelectionButtons();
  });

  applyTheme(localStorage.getItem(THEME_KEY) || 'system');
  void load();
})();
