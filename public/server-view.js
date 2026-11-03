'use strict';

// Le panneau serveur ne connaît ni conversations ni websocket. Il transforme un relevé de
// l'API adminPanel en une vue et protège celle-ci des réponses arrivées dans le désordre.
(function expose(root) {
  function create(d) {
    let requestSeq = 0;
    let mounted = false;
    const bytes = (value) => {
      const n = Number(value) || 0;
      if (n >= 1e12) return `${(n / 1e12).toFixed(2)} To`;
      if (n >= 1e9) return `${(n / 1e9).toFixed(1)} Go`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(0)} Mo`;
      return `${(n / 1e3).toFixed(0)} ko`;
    };
    const uptime = (seconds) => {
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      return days ? `${days} j ${hours} h` : `${hours} h`;
    };
    const error = (part, label) => `<div class="empty">${d.esc(label)} — ${d.esc(part.error)}</div>`;

    function render(data) {
      if (data.webUrl) d.$('#server-open').href = data.webUrl;
      if (!data.available) {
        d.$('#server-sub').textContent = 'Panneau non configuré';
        d.$('#server-totals').innerHTML = '';
        d.$('#server-disk').innerHTML = `<div class="empty">
          Panneau serveur optionnel non configuré.<br>
          Définissez <code>AGENTHUB_PANEL_TOKEN_FILE</code> pour fournir son jeton de service.<br>
          Il est en lecture seule : ce panneau ne peut rien changer d'ici.</div>`;
        ['#server-pm2', '#server-services', '#server-sites'].forEach((id) => { d.$(id).innerHTML = ''; });
        return;
      }
      const system = data.system || {};
      d.$('#server-sub').textContent = system.hostname
        ? `${system.hostname} · ${system.platform} · node ${system.nodeVersion}` : 'Relevé partiel';
      d.$('#server-totals').innerHTML = system.error ? '' : [
        { label: 'Charge', value: (system.loadAvg || [0])[0].toFixed(2), note: `${system.cpuCount} cœurs · ${(system.loadAvg || []).map((n) => n.toFixed(2)).join(' / ')}` },
        { label: 'Mémoire', value: `${Math.round(((system.memory || {}).used / (system.memory || {}).total) * 100)} %`, note: `${bytes((system.memory || {}).used)} sur ${bytes((system.memory || {}).total)}`, accent: (system.memory || {}).used / (system.memory || {}).total > 0.9 },
        { label: 'Disque', value: `${Math.round(((system.disk || {}).used / (system.disk || {}).total) * 100)} %`, note: `${bytes((system.disk || {}).free)} libres` },
        { label: 'En marche depuis', value: uptime(system.uptime || 0) },
      ].map((tile) => `<div class="tile"><div class="tile-label">${tile.label}</div><div class="tile-value${tile.accent ? ' accent' : ''}">${d.esc(tile.value)}</div>${tile.note ? `<div class="tile-note">${d.esc(tile.note)}</div>` : ''}</div>`).join('');

      const disks = data.disk;
      d.$('#server-disk').innerHTML = disks.error ? error(disks, 'Disques') : `<h3 class="board-title">Disques</h3><div class="bars">${disks.map((disk) =>
        `<div class="bar-row" title="${d.escAttr(`${disk.source} · ${disk.fstype}`)}"><span class="bar-name">${d.esc(disk.target)}</span><span class="bar-track"><span class="bar-fill" style="width:${disk.usedPercent}%"></span></span><span class="bar-num">${disk.usedPercent} %</span><span class="bar-note">${bytes(disk.avail)} libres sur ${bytes(disk.size)}</span></div>`
      ).join('')}</div>`;

      const pm2 = data.pm2;
      d.$('#server-pm2').innerHTML = pm2.error ? error(pm2, 'PM2') : (() => {
        const rows = [...pm2].sort((a, b) => a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'online' ? 1 : -1);
        const down = rows.filter((p) => p.status !== 'online').length;
        return `<h3 class="board-title">PM2 — ${rows.length} process${down ? `, ${down} arrêté(s)` : ''}</h3><div class="table-wrap"><table class="models"><thead><tr><th>Process</th><th>État</th><th>CPU</th><th>Mémoire</th><th>Redémarrages</th></tr></thead><tbody>${rows.map((p) =>
          `<tr><td><span class="model-name">${d.esc(p.name)}</span></td><td><span class="srv-state srv-${p.status === 'online' ? 'on' : 'off'}">${d.esc(p.status)}</span></td><td>${p.cpu} %</td><td>${bytes(p.memory)}</td><td>${p.restarts}</td></tr>`
        ).join('')}</tbody></table></div>`;
      })();

      const services = data.services;
      d.$('#server-services').innerHTML = services.error ? error(services, 'Services') : `<h3 class="board-title">Services</h3><div class="srv-list">${services.map((service) =>
        `<div class="srv-row" title="${d.escAttr(service.description || '')}"><span class="srv-state srv-${service.active ? 'on' : 'off'}">${service.active ? 'actif' : d.esc(service.activeState || 'arrêté')}</span><span class="srv-name">${d.esc(service.label || service.unit)}</span><span class="srv-role">${d.esc(service.role || '')}</span><span class="srv-mem">${service.memory ? bytes(service.memory) : ''}</span></div>`
      ).join('')}</div>`;

      const sites = data.sites;
      d.$('#server-sites').innerHTML = sites.error ? error(sites, 'Sites') : `<h3 class="board-title">Sites — ${sites.filter((site) => site.healthy).length}/${sites.length} en bonne santé</h3><div class="srv-list">${sites.map((site) =>
        `<div class="srv-row" title="${d.escAttr((site.domains || []).join(', '))}"><span class="srv-state srv-${site.healthy ? 'on' : 'off'}">${site.status || '—'}</span><span class="srv-name">${d.esc(site.primaryDomain || site.file)}</span><span class="srv-role">${d.esc(site.type || '')}${site.port ? ` · :${site.port}` : ''}</span><span class="srv-mem">${site.ms ? `${site.ms} ms` : d.esc(site.error || '')}</span></div>`
      ).join('')}</div>`;
    }

    async function show() {
      d.showView('#server-view');
      d.renderConversationList();
      d.$('#server-sub').textContent = 'Lecture…';
      const seq = ++requestSeq;
      try {
        const data = await d.api('GET', '/api/panel');
        if (seq !== requestSeq || d.$('#server-view').classList.contains('hidden')) return false;
        render(data); return true;
      } catch (cause) {
        if (seq === requestSeq && !d.$('#server-view').classList.contains('hidden')) {
          d.$('#server-sub').textContent = '';
          d.$('#server-totals').innerHTML = `<div class="empty">${d.esc(cause.message)}</div>`;
        }
        return false;
      }
    }

    function mount() {
      if (mounted) return;
      mounted = true;
      d.$('#btn-server').addEventListener('click', () => { show(); d.closeNav(); });
      d.$('#btn-server-refresh').addEventListener('click', show);
      d.$('#btn-server-back').addEventListener('click', () => document.body.classList.add('nav-open'));
    }
    return Object.freeze({ mount, show });
  }
  root.AgentHubServerView = Object.freeze({ create });
})(window);
