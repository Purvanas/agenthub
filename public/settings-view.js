'use strict';

// Le formulaire de configuration est un domaine autonome : sa description, son état et ses
// requêtes vivent ensemble. L'appelant injecte seulement les primitives communes.
(function expose(root) {
  const schema = [
    {
      key: 'notify',
      title: 'Notifications',
      hint:
        'Un POST sortant à la fin d’un turn, et dès qu’un agent pose une question. ' +
        'Le Web Push du navigateur est hors jeu quand l’app est servie en http : il exige https.',
      test: 'Envoyer une notification d’essai',
      fields: [
        { name: 'enabled', type: 'bool', label: 'Notifier' },
        {
          name: 'format',
          type: 'select',
          label: 'Destination',
          options: [
            ['ntfy', 'ntfy'],
            ['json', 'Webhook JSON maison'],
          ],
        },
        { name: 'url', type: 'text', label: 'URL du serveur', placeholder: 'https://ntfy.sh' },
        {
          name: 'topic',
          type: 'text',
          label: 'Sujet ntfy',
          hint: 'Le nom auquel l’application ntfy de ton téléphone est abonnée. Requis pour ce format.',
        },
        {
          name: 'appUrl',
          type: 'text',
          label: 'Lien vers agentHub',
          hint: 'Mis dans la notification, avec l’ancre de la conversation. Vide : pas de lien.',
        },
        {
          name: 'events',
          type: 'checks',
          label: 'Fins de turn notifiées',
          hint:
            'Une question d’agent part toujours, hors de cette liste : rien ne repart tant ' +
            'qu’elle est sans réponse. Elle attend une minute si quelqu’un a la conversation à l’écran.',
          options: [
            ['done', 'Terminé'],
            ['error', 'En échec'],
            ['stopped', 'Interrompu'],
          ],
        },
      ],
    },
    {
      key: 'mail',
      title: 'Mail',
      hint: 'Rapports de fin de déclencheur. Le mot de passe ne repart jamais vers le navigateur.',
      test: 'Envoyer un mail d’essai',
      fields: [
        { name: 'enabled', type: 'bool', label: 'Envoyer des mails' },
        { name: 'host', type: 'text', label: 'Hôte SMTP', placeholder: 'smtp.exemple.fr' },
        { name: 'port', type: 'number', label: 'Port' },
        { name: 'secure', type: 'bool', label: 'TLS direct (port 465)' },
        { name: 'user', type: 'text', label: 'Utilisateur' },
        { name: 'pass', type: 'password', label: 'Mot de passe', hint: 'Laisser vide pour ne pas le changer.' },
        { name: 'from', type: 'text', label: 'Expéditeur' },
        { name: 'to', type: 'text', label: 'Destinataire par défaut' },
      ],
    },
    {
      key: 'browser',
      title: 'Navigateur des agents',
      hint:
        'Le serveur MCP Playwright tourne à côté d’agentHub, pas dedans : il a son propre ' +
        'Chromium et son propre service PM2.',
      test: 'Vérifier que le service répond',
      fields: [
        { name: 'enabled', type: 'bool', label: 'Proposer un navigateur aux agents' },
        {
          name: 'url',
          type: 'text',
          label: 'URL du serveur MCP',
          hint:
            'Écrire « localhost » et non « 127.0.0.1 » : Playwright MCP vérifie l’en-tête Host ' +
            'et répond « Access is denied » sinon.',
        },
        { name: 'name', type: 'text', label: 'Nom vu par les CLIs' },
        {
          name: 'grokGlobal',
          type: 'bool',
          label: 'Grok l’a en permanence',
          hint:
            'Purement déclaratif. À cocher seulement après un `grok mcp add` : Grok ne sait pas ' +
            'recevoir de configuration MCP à l’appel, la sienne est globale.',
        },
      ],
    },
    {
      key: 'memory',
      title: 'Mémoire de projet',
      hint:
        'Un turn qui s’est cogné et s’en est sorti a peut-être appris quelque chose. Un second ' +
        'turn, dans la même conversation, en tire une fiche — que tu gardes ou écartes. Les ' +
        'fiches gardées sont remises dans le prompt des conversations du même projet.',
      fields: [
        {
          name: 'enabled',
          type: 'bool',
          label: 'Tirer des leçons des turns qui se sont cognés',
          hint:
            'Chaque fiche coûte un turn de plus, avec tout le contexte de la conversation en ' +
            'entrée. Rien n’est demandé sur un turn qui n’a rencontré aucune erreur.',
        },
        {
          name: 'writeFile',
          type: 'bool',
          label: 'Écrire aussi la fiche dans docs/solutions/ du projet',
          hint:
            'Seulement si ce dossier existe déjà : on suit la convention d’un dépôt, on ne lui ' +
            'en impose pas. Le fichier est neuf et non suivi par git.',
        },
      ],
    },
    {
      key: 'groups',
      title: 'Dossiers de travail',
      hint: 'Ce que propose le sélecteur de dossier, à la création d’une conversation.',
      fields: [
        {
          name: 'groups',
          type: 'groups',
          label: 'Groupes',
          hint:
            'L’ordre fait la priorité : un dossier déjà classé n’est pas repris par les suivants. ' +
            'Un motif finissant par /* prend les sous-dossiers directs.',
        },
        {
          name: 'newFolderParents',
          type: 'lines',
          label: 'Où créer un nouveau dossier',
          hint: 'Un chemin par ligne.',
        },
        {
          name: 'exclude',
          type: 'lines',
          label: 'Noms exclus',
          hint: 'Une expression régulière par ligne, appliquée au nom du dossier.',
        },
      ],
    },
  ];
  
  function create(d) {
    let sections = {};
    let loadSeq = 0;
    let mounted = false;
    const byKey = new Map(schema.map((section) => [section.key, section]));
    const visible = () => !d.$('#settings-view').classList.contains('hidden');

    function groupRow(group) {
      return `<div class="set-group"><input type="text" class="set-group-label" value="${d.escAttr(group.label || '')}" placeholder="Nom du groupe">
        <textarea class="set-group-patterns" rows="${Math.max(2, (group.patterns || []).length)}" placeholder="./*">${d.esc((group.patterns || []).join('\n'))}</textarea>
        <button type="button" class="ghost set-group-del" title="Retirer ce groupe"><svg class="icon"><use href="#i-trash"/></svg></button></div>`;
    }

    function fieldHtml(section, field, values, overridden) {
      const id = `set-${section.key}-${field.name}`;
      const value = values[field.name];
      const changed = overridden.includes(field.name) ? ' set-changed' : '';
      const hint = field.hint ? `<p class="set-hint">${d.esc(field.hint)}</p>` : '';
      const name = d.escAttr(field.name);
      if (field.type === 'bool') return `<div class="set-field set-bool${changed}"><label for="${id}"><input type="checkbox" id="${id}" data-set="${name}"${value ? ' checked' : ''}><span>${d.esc(field.label)}</span></label>${hint}</div>`;
      if (field.type === 'checks') {
        const boxes = field.options.map(([v, l]) => `<label class="set-check"><input type="checkbox" data-set-item="${d.escAttr(v)}"${(value || []).includes(v) ? ' checked' : ''}><span>${d.esc(l)}</span></label>`).join('');
        return `<div class="set-field${changed}" data-set-group="${name}"><span class="set-label">${d.esc(field.label)}</span><div class="set-checks">${boxes}</div>${hint}</div>`;
      }
      if (field.type === 'select') {
        const options = field.options.map(([v, l]) => `<option value="${d.escAttr(v)}"${value === v ? ' selected' : ''}>${d.esc(l)}</option>`).join('');
        return `<div class="set-field${changed}"><label class="set-label" for="${id}">${d.esc(field.label)}</label><select id="${id}" data-set="${name}">${options}</select>${hint}</div>`;
      }
      if (field.type === 'lines') return `<div class="set-field${changed}"><label class="set-label" for="${id}">${d.esc(field.label)}</label><textarea id="${id}" data-set="${name}" rows="${Math.min(12, Math.max(3, (value || []).length + 1))}">${d.esc((value || []).join('\n'))}</textarea>${hint}</div>`;
      if (field.type === 'groups') return `<div class="set-field${changed}" data-set-groups="${name}"><span class="set-label">${d.esc(field.label)}</span><div class="set-group-list">${(value || []).map(groupRow).join('')}</div><button type="button" class="secondary set-group-add">Ajouter un groupe</button>${hint}</div>`;
      const type = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text';
      const placeholder = field.type === 'password' && values[`${field.name}Set`] ? 'inchangé' : field.placeholder || '';
      return `<div class="set-field${changed}"><label class="set-label" for="${id}">${d.esc(field.label)}</label><input type="${type}" id="${id}" data-set="${name}" value="${d.escAttr(value == null ? '' : value)}"${placeholder ? ` placeholder="${d.escAttr(placeholder)}"` : ''}>${hint}</div>`;
    }

    function render() {
      d.$('#settings-body').innerHTML = schema.map((section) => {
        const data = sections[section.key] || { values: {}, overridden: [] };
        const modified = data.overridden.length ? `<span class="set-badge" title="${d.escAttr(`Écarts enregistrés dans data/settings.json : ${data.overridden.join(', ')}`)}">modifié</span>` : '';
        return `<section class="set-card" data-section="${d.escAttr(section.key)}"><div class="set-card-head"><h3>${d.esc(section.title)}</h3>${modified}</div>
          <p class="set-intro">${d.esc(section.hint)}</p><div class="set-fields">${section.fields.map((field) => fieldHtml(section, field, data.values, data.overridden)).join('')}</div>
          <div class="set-foot">${data.overridden.length ? '<button type="button" class="secondary set-reset">Revenir aux valeurs du dépôt</button>' : ''}${section.test ? `<button type="button" class="secondary set-test">${d.esc(section.test)}</button>` : ''}<button type="button" class="primary set-save">Enregistrer</button><span class="set-result"></span></div></section>`;
      }).join('');
    }

    function collect(card) {
      const section = byKey.get(card.dataset.section);
      const output = {};
      for (const field of section.fields) {
        if (field.type === 'checks') {
          const box = card.querySelector(`[data-set-group="${d.cssEscape(field.name)}"]`);
          output[field.name] = [...box.querySelectorAll('[data-set-item]')].filter((i) => i.checked).map((i) => i.dataset.setItem);
        } else if (field.type === 'groups') {
          output[field.name] = [...card.querySelectorAll('.set-group')].map((row) => ({ label: row.querySelector('.set-group-label').value, patterns: row.querySelector('.set-group-patterns').value.split('\n') }));
        } else {
          const element = card.querySelector(`[data-set="${d.cssEscape(field.name)}"]`);
          if (!element) continue;
          output[field.name] = field.type === 'bool' ? element.checked : field.type === 'lines' ? element.value.split('\n') : field.type === 'number' ? Number(element.value) : element.value;
        }
      }
      return output;
    }

    function result(section, ok, text) {
      const slot = document.querySelector(`.set-card[data-section="${d.cssEscape(section)}"] .set-result`);
      if (!slot) return;
      slot.textContent = text; slot.classList.toggle('bad', !ok); slot.classList.toggle('good', ok);
    }

    async function load() {
      const seq = ++loadSeq;
      try {
        const data = await d.api('GET', '/api/settings');
        if (seq !== loadSeq) return false;
        sections = data.sections;
        if (visible()) render();
        return true;
      } catch (error) {
        if (seq === loadSeq && visible()) d.$('#settings-body').innerHTML = `<div class="empty">${d.esc(error.message)}</div>`;
        return false;
      }
    }

    async function show() {
      d.showView('#settings-view'); d.renderConversationList(); return load();
    }

    function mount() {
      if (mounted) return;
      mounted = true;
      d.$('#settings-body').addEventListener('click', handleClick);
      d.$('#btn-settings').addEventListener('click', () => { show(); d.closeNav(); });
      d.$('#btn-settings-refresh').addEventListener('click', load);
      d.$('#btn-settings-back').addEventListener('click', () => document.body.classList.add('nav-open'));
    }

    async function handleClick(event) {
      const card = event.target.closest('.set-card');
      if (!card) return;
      if (event.target.closest('.set-group-add')) {
        card.querySelector('.set-group-list').insertAdjacentHTML('beforeend', groupRow({ label: '', patterns: [] })); return;
      }
      const drop = event.target.closest('.set-group-del');
      if (drop) return void drop.closest('.set-group').remove();
      const save = event.target.closest('.set-save');
      const test = event.target.closest('.set-test');
      const reset = event.target.closest('.set-reset');
      if (!save && !test && !reset) return;
      const button = save || test || reset;
      const section = card.dataset.section;
      // Toute mutation rend obsolète un GET parti avant le clic. Une seconde invalidation
      // au retour couvre aussi un rafraîchissement lancé pendant l'écriture.
      loadSeq += 1;
      button.disabled = true; result(section, true, '…');
      try {
        if (reset) {
          const data = await d.api('DELETE', `/api/settings/${section}`);
          loadSeq += 1;
          sections = data.sections; if (visible()) render(); if (section === 'groups') d.loadProjects().catch(() => {});
          d.toast('Valeurs du dépôt rétablies'); return;
        }
        const values = collect(card);
        if (save) {
          const data = await d.api('POST', `/api/settings/${section}`, values);
          loadSeq += 1;
          sections = data.sections; if (visible()) render(); if (section === 'groups') d.loadProjects().catch(() => {});
          d.toast('Enregistré'); return;
        }
        const output = await d.api('POST', `/api/settings/${section}/test`, { values });
        await load();
        if (visible()) result(section, output.ok, output.detail || (output.ok ? 'OK' : 'Échec'));
      } catch (error) {
        if (visible()) result(section, false, error.message);
      }
      finally { if (button.isConnected) button.disabled = false; }
    }

    return Object.freeze({ mount, show, load });
  }
  root.AgentHubSettingsView = Object.freeze({ create });
})(window);
