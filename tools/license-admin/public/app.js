/* 授权管理工具前端：无构建步骤，直接和本地 Express 管理接口通信。 */
(() => {
  const params = new URLSearchParams(location.search);
  let token = params.get('token') || sessionStorage.getItem('tuku-admin-token') || '';
  if (params.get('token')) {
    sessionStorage.setItem('tuku-admin-token', params.get('token'));
    history.replaceState({}, '', location.pathname);
  }

  let state = null;
  let filter = '';

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

  const statusLabel = { active: '有效', expired: '已过期', revoked: '已停用' };
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
      ['授权记录', s.records, '台设备'],
      ['手机号', s.phones, '个账号'],
      ['有效', s.active, '条'],
      ['7 天内到期', s.expiring7, '条'],
      ['已停用', s.revoked, '条记录'],
      ['过期', s.expired, '条'],
    ]
      .map(
        ([label, num, suffix]) =>
          `<div class="stat"><div class="num">${esc(num)}</div><div class="label">${esc(label)} · ${esc(suffix)}</div></div>`
      )
      .join('');

    $('issueBtn').disabled = !state.keyReady;
    $('revokePhoneBtn').disabled = !state.keyReady;
    $('revokeMachineBtn').disabled = !state.keyReady;

    renderTable();
    renderRevocations();
    renderManifest();
  }

  function renderTable() {
    const box = $('listTable');
    if (!state?.licenses?.length) {
      box.innerHTML = '<div class="empty-row">还没有授权记录。到「签发授权」填手机号和设备码。</div>';
      return;
    }
    const q = filter.trim().toLowerCase();
    const rows = state.licenses.filter((x) =>
      !q ? true : [x.phone, x.machine, x.note].some((v) => String(v ?? '').toLowerCase().includes(q))
    );
    if (!rows.length) {
      box.innerHTML = '<div class="empty-row">没有匹配的记录。</div>';
      return;
    }
    const revokedPhones = new Set(state.revocations.phones);
    const revokedMachines = new Set(state.revocations.machines);
    box.innerHTML = `<table>
      <thead><tr>
        <th>手机号 / 备注</th><th>设备码</th><th>状态</th><th>签发</th><th>到期</th><th>操作</th>
      </tr></thead>
      <tbody>${rows
        .map((x) => {
          const phoneRevoked = revokedPhones.has(x.phone);
          const machineRevoked = revokedMachines.has(x.machine);
          const expiry = x.expires ? esc(x.expires) : '永久';
          const left =
            x.status === 'expired'
              ? '已过期'
              : x.daysLeft != null
                ? `剩 ${x.daysLeft} 天`
                : '';
          return `<tr>
            <td><div class="phone">${esc(x.phone)}</div>${x.note ? `<div class="hint">${esc(x.note)}</div>` : ''}</td>
            <td class="mono">${esc(x.machine)}${x.deviceVersion === 1 ? '<div class="hint">旧版 16 位</div>' : ''}</td>
            <td><span class="badge ${esc(x.status)}">${esc(statusLabel[x.status] || x.status)}</span></td>
            <td>${esc(x.issuedAt)}</td>
            <td>${expiry}${left ? `<div class="hint">${esc(left)}</div>` : ''}</td>
            <td class="actions">
              <button class="btn sm" data-action="copy-key" data-id="${esc(x.id)}">复制激活码</button>
              ${
                machineRevoked
                  ? `<button class="btn sm ghost" data-action="unrevoke-machine" data-values="${esc(x.machine)}">恢复设备</button>`
                  : `<button class="btn sm danger" data-action="revoke-machine" data-values="${esc(x.machine)}">取消设备授权</button>`
              }
              ${
                phoneRevoked
                  ? `<button class="btn sm ghost" data-action="unrevoke-phone" data-values="${esc(x.phone)}">恢复手机号</button>`
                  : `<button class="btn sm ghost" data-action="revoke-phone" data-values="${esc(x.phone)}">停用手机号</button>`
              }
              <button class="btn sm ghost" data-action="delete" data-id="${esc(x.id)}">删除记录</button>
            </td>
          </tr>`;
        })
        .join('')}</tbody>
    </table>`;
  }

  function renderRevocations() {
    const phones = state.revocations.phones;
    const machines = state.revocations.machines;
    $('revokedPhoneList').innerHTML = phones.length
      ? phones
          .map(
            (p) =>
              `<span class="chip">${esc(p)}<button data-action="unrevoke-phone" data-values="${esc(p)}" title="解除停用">✕</button></span>`
          )
          .join('')
      : '<span class="hint">暂无停用手机号</span>';
    $('revokedMachineList').innerHTML = machines.length
      ? machines
          .map(
            (m) =>
              `<span class="chip">${esc(fmtDevice(m))}<button data-action="unrevoke-machine" data-values="${esc(m)}" title="解除停用">✕</button></span>`
          )
          .join('')
      : '<span class="hint">暂无停用设备</span>';
  }

  function renderManifest() {
    const tokenText = state.manifest?.token || '';
    $('manifestSeq').textContent = `seq ${state.seq}`;
    $('manifestPath').textContent = state.admin.manifestFile;
    $('manifestUrl').textContent = state.admin.manifestUrl;
    $('publishPath').textContent = state.admin.publishFile || '（未找到仓库发布文件）';
    $('publishUrl').textContent = state.admin.publishUrl || '';
    $('manifestText').value = tokenText || '（还没有停用记录；添加手机号或设备后自动生成签名清单）';
    $('copyManifest').disabled = !tokenText;
    $('downloadManifest').disabled = !tokenText;
    $('publishFile').disabled = !tokenText || !state.admin.publishFile;
  }

  function renderIssueResult(created) {
    if (!created?.length) return;
    const html = `
      <div class="result">
        ${created
          .map(
            (x) => `<div class="key-item">
              <div class="meta"><span>${esc(x.phone)} · ${esc(x.machine)}</span><span>${esc(x.expires || '永久')}</span></div>
              <div class="key">${esc(x.key)}</div>
              <button class="btn sm" data-action="copy-key" data-id="${esc(x.id)}">复制这个激活码</button>
            </div>`
          )
          .join('')}
        <div class="row">
          <button class="btn primary" data-action="copy-created">复制全部激活码</button>
          <button class="btn ghost" data-action="download-created">下载 TXT</button>
        </div>
      </div>`;
    $('issueResult').className = 'result';
    $('issueResult').innerHTML = html;
    $('issueResult').dataset.ids = created.map((x) => x.id).join(',');
  }

  function createdRecords() {
    const ids = String($('issueResult').dataset.ids || '').split(',').filter(Boolean);
    return (state?.licenses || []).filter((x) => ids.includes(x.id));
  }

  async function revoke(scope, value, revoked) {
    const label = scope === 'phone' ? '手机号' : '设备';
    const verb = revoked ? '停用' : '恢复';
    const extra =
      scope === 'phone' && revoked ? '\n\n注意：该手机号下的所有设备都会一起被锁定。' : '';
    if (!confirm(`确定${verb}${label}「${value}」？${extra}`)) return;
    try {
      const data = await api('/api/revoke', {
        method: 'POST',
        body: JSON.stringify({ scope, value, revoked }),
      });
      state = data.state;
      render();
      toast(`${label}已${verb}${data.changed ? '' : '（无变化）'}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function deleteRecord(id) {
    const rec = state?.licenses.find((x) => x.id === id);
    if (!rec) return;
    if (
      !confirm(
        `只删除这条台账记录，不会让已经激活的客户端失效。\n要真正取消授权，请用「取消设备授权」或「停用手机号」。\n\n确定删除 ${rec.phone} · ${rec.machine}？`
      )
    )
      return;
    try {
      const data = await api('/api/delete', { method: 'POST', body: JSON.stringify({ id }) });
      state = data.state;
      render();
      toast('记录已删除');
    } catch (err) {
      toast(err.message, 'error');
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

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      for (const name of ['issue', 'list', 'revoke']) {
        $(`tab-${name}`).hidden = tab.dataset.tab !== name;
      }
    });
  });

  $('days').addEventListener('change', () => {
    $('expiresField').hidden = $('days').value !== 'custom';
  });

  $('search').addEventListener('input', () => {
    filter = $('search').value;
    renderTable();
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

  $('issueForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state?.keyReady) return toast('未找到授权私钥，无法签发', 'error');
    const phone = $('phone').value.trim();
    const machines = $('machines').value.trim();
    const mode = $('days').value;
    const body = {
      phone,
      machines,
      note: $('note').value.trim(),
      edition: 'pro',
    };
    if (mode === 'custom') {
      body.expires = $('expires').value;
      if (!body.expires) return toast('请选择到期日', 'error');
    } else {
      body.days = Number(mode);
    }
    const btn = $('issueBtn');
    btn.disabled = true;
    try {
      const data = await api('/api/issue', { method: 'POST', body: JSON.stringify(body) });
      state = data.state;
      render();
      renderIssueResult(data.created);
      $('machines').value = '';
      toast(`已签发 ${data.created.length} 个授权码`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = !state?.keyReady;
    }
  });

  $('revokePhoneBtn').addEventListener('click', () => {
    const value = $('revokePhone').value.trim();
    if (!value) return toast('请先填手机号', 'error');
    void revoke('phone', value, true);
    $('revokePhone').value = '';
  });
  $('revokeMachineBtn').addEventListener('click', () => {
    const value = $('revokeMachine').value.trim();
    if (!value) return toast('请先填设备码', 'error');
    void revoke('machine', value, true);
    $('revokeMachine').value = '';
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
    } else if (action === 'copy-created') {
      const text = createdRecords()
        .map((x) => `${x.phone}\t${x.machine}\t${x.expires || '永久'}\t${x.key}`)
        .join('\n');
      if (text) void copy(text);
    } else if (action === 'download-created') {
      const text = createdRecords()
        .map((x) => `${x.phone}\t${x.machine}\t${x.expires || '永久'}\n${x.key}`)
        .join('\n\n');
      if (text) download(`license-keys-${new Date().toISOString().slice(0, 10)}.txt`, text);
    } else if (action === 'revoke-machine') {
      void revoke('machine', value, true);
    } else if (action === 'unrevoke-machine') {
      void revoke('machine', value, false);
    } else if (action === 'revoke-phone') {
      void revoke('phone', value, true);
    } else if (action === 'unrevoke-phone') {
      void revoke('phone', value, false);
    } else if (action === 'delete') {
      void deleteRecord(id);
    }
  });

  void load();
})();
