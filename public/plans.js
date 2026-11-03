'use strict';

// Le tiroir des plans et des schémas d'un projet.
//
// Deux moitiés, et la frontière est celle des tests. En haut, du rendu **pur** — markdown vers
// HTML, badges d'un document, découpage d'un texte en blocs — vérifiable sans navigateur.
// En bas, le DOM : le tiroir, les onglets, l'éditeur, mermaid.
//
// **Pourquoi un rendu markdown à part de celui du fil.** `md()` dans `app.js` rend de la sortie
// d'agent : il fabrique des cartes d'idée à partir de `[idée]`, et résout les images contre la
// conversation courante. Les deux sont faux ici — un plan qui contient le mot `[idée]` dans une
// phrase n'a pas à devenir un bouton, et son `![](schema.png)` est relatif au fichier, pas à la
// session d'un provider. Ce rendu-ci connaît en revanche ce dont un document de conception a
// besoin et que le fil n'a jamais : des **tableaux**, des **cases à cocher**, des titres
// hiérarchisés, et des blocs mermaid qui deviennent des dessins.
//
// **Pourquoi mermaid est embarqué et non appelé sur un CDN.** `index.html` ne charge aujourd'hui
// aucune URL externe, et l'application est jointe par des chemins dont certains n'ont pas
// Internet. Un schéma qui ne s'affiche pas parce qu'un CDN est injoignable serait une panne
// incompréhensible depuis l'interface. Le fichier est donc dans `public/vendor/`, à version
// figée — voir `public/vendor/README.md`.

/** Rang d'affichage des statuts. Doit rester accordé à STATUS_RANK dans lib/plans.js. */
const STATUS_CLASS = {
  'en-cours': 'st-doing',
  brouillon: 'st-draft',
  'prévu': 'st-todo',
  'terminé': 'st-done',
  'abandonné': 'st-dropped',
  autre: 'st-other',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;');
}

/**
 * Mise en forme dans une ligne, sur du texte **déjà échappé**.
 *
 * Le code en ligne est **mis de côté** avant tout le reste, et non simplement traité en
 * premier. La nuance décide du résultat : remplacer les backticks d'abord laisse le contenu
 * dans la chaîne, où la règle du gras le retrouve — `` `**pas du gras**` `` ressortait en
 * `<code><strong>pas du gras</strong></code>`. Or un plan cite des noms de champs et des
 * options en ligne, et c'est justement là que les astérisques sont littérales.
 */
function inline(escaped) {
  const spans = [];
  let text = String(escaped).replace(/`([^`\n]+)`/g, (_, code) => {
    spans.push(`<code>${code}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });

  text = text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<em>${alt || 'image'} (${src})</em>`)
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_, label, href) =>
        `<a href="${href.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${label}</a>`
    )
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  return text.replace(/\u0000(\d+)\u0000/g, (_, n) => spans[Number(n)]);
}

/**
 * Un tableau markdown vers un `<table>`. Rend `null` si les lignes n'en forment pas un.
 *
 * Les tableaux ne sont pas un luxe dans ce tiroir : les plans de ce dépôt en sont pleins —
 * une colonne « champ », une colonne « type », une colonne « pourquoi ». Rendus en texte brut
 * ils deviennent une bouillie de barres verticales, ce qui est exactement l'état dont cette
 * fonctionnalité doit sortir.
 */
function table(lines) {
  if (lines.length < 2) return null;
  const cells = (row) =>
    row
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((c) => c.trim());
  if (!/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[1])) return null;

  const head = cells(lines[0]);
  const align = cells(lines[1]).map((spec) => {
    if (/^:-+:$/.test(spec)) return 'center';
    if (/^-+:$/.test(spec)) return 'right';
    return '';
  });
  const at = (i) => (align[i] ? ` style="text-align:${align[i]}"` : '');

  const body = lines
    .slice(2)
    .map(
      (row) =>
        `<tr>${cells(row)
          .map((c, i) => `<td${at(i)}>${inline(esc(c))}</td>`)
          .join('')}</tr>`
    )
    .join('');

  return (
    `<table class="doc-table"><thead><tr>` +
    head.map((c, i) => `<th${at(i)}>${inline(esc(c))}</th>`).join('') +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

/**
 * Markdown d'un document vers HTML.
 *
 * Volontairement un analyseur par lignes et non par expressions régulières sur tout le texte :
 * un document de conception imbrique des listes sous des titres et des tableaux après des
 * paragraphes, et l'approche « une regex par forme » finit toujours par transformer un `-`
 * dans un bloc de code en puce.
 *
 * Les blocs mermaid ne sont pas rendus ici — ils ne peuvent pas l'être, mermaid est
 * asynchrone. Ils laissent un conteneur marqué `data-mermaid`, que `paintDiagrams` remplit
 * ensuite. Un document sans JavaScript montrerait donc le code source du diagramme, ce qui
 * est le bon repli : c'est du texte qui se lit.
 */
function markdown(text) {
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out = [];

  // Le frontmatter n'est pas du contenu : il est déjà rendu en badges au-dessus du document.
  let i = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) i = end + 1;
  }

  let list = null; // 'ul' | 'ol' | null
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  for (; i < lines.length; i += 1) {
    const line = lines[i];

    // --- Clôture de code, mermaid compris -------------------------------
    const fence = /^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      closeList();
      // La clôture se ferme sur **le même caractère, au moins aussi long**. Ni l'un ni l'autre
      // n'est un détail : une version antérieure comparait le marqueur reconstitué (« ``` ») au
      // caractère seul (« ` »), test toujours faux, et cherchait donc « ~~~ » pour fermer une
      // clôture en accents graves. Conséquence : le premier bloc ```mermaid d'un plan avalait
      // tout le reste du document, qui disparaissait dans un diagramme illisible. Aucun test ne
      // l'avait vu parce qu'ils plaçaient tous la clôture en fin de texte.
      const marker = fence[1][0];
      const closing = new RegExp(`^\\s*${marker}{${fence[1].length},}\\s*$`);
      const lang = fence[2].toLowerCase();
      const body = [];
      i += 1;
      for (; i < lines.length; i += 1) {
        if (closing.test(lines[i])) break;
        body.push(lines[i]);
      }
      const code = body.join('\n');
      if (lang === 'mermaid') {
        out.push(
          `<figure class="doc-diagram" data-mermaid="${escAttr(code)}">` +
            `<pre class="doc-diagram-src">${esc(code)}</pre></figure>`
        );
      } else {
        out.push(`<pre><code data-lang="${escAttr(lang)}">${esc(code)}</code></pre>`);
      }
      continue;
    }

    // --- Titres ---------------------------------------------------------
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      closeList();
      const level = head[1].length;
      out.push(`<h${level} class="doc-h doc-h${level}">${inline(esc(head[2].trim()))}</h${level}>`);
      continue;
    }

    // --- Filet ----------------------------------------------------------
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      closeList();
      out.push('<hr class="doc-hr">');
      continue;
    }

    // --- Tableau --------------------------------------------------------
    if (/\|/.test(line) && !/^\s*>/.test(line)) {
      const rows = [];
      let j = i;
      for (; j < lines.length && /\|/.test(lines[j]) && lines[j].trim(); j += 1) rows.push(lines[j]);
      const html = table(rows);
      if (html) {
        closeList();
        out.push(html);
        i = j - 1;
        continue;
      }
    }

    // --- Citation -------------------------------------------------------
    if (/^\s*>\s?/.test(line)) {
      closeList();
      const quote = [];
      for (; i < lines.length && /^\s*>\s?/.test(lines[i]); i += 1) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
      }
      i -= 1;
      out.push(`<blockquote class="doc-quote">${inline(esc(quote.join(' ')))}</blockquote>`);
      continue;
    }

    // --- Listes, cases à cocher comprises -------------------------------
    //
    // Les cases sont rendues **désactivées**. Une case cliquable dans une vue de lecture
    // promettrait d'écrire dans le fichier au clic, ce qui n'est pas ce qui se passe : on
    // modifie un plan en passant en édition. Une case qui se décoche sans rien enregistrer
    // serait pire que pas de case du tout.
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const want = /^\d/.test(item[2]) ? 'ol' : 'ul';
      if (list !== want) {
        closeList();
        out.push(`<${want} class="doc-list">`);
        list = want;
      }
      let body = item[3];
      const box = /^\[([ xX])\]\s*(.*)$/.exec(body);
      if (box) {
        const done = box[1].toLowerCase() === 'x';
        out.push(
          `<li class="doc-task${done ? ' done' : ''}">` +
            `<input type="checkbox" disabled${done ? ' checked' : ''}>` +
            `<span>${inline(esc(box[2]))}</span></li>`
        );
        continue;
      }
      out.push(`<li>${inline(esc(body))}</li>`);
      continue;
    }

    // --- Paragraphe -----------------------------------------------------
    if (!line.trim()) {
      closeList();
      continue;
    }
    // Les lignes consécutives forment un seul paragraphe : les plans de ce dépôt sont écrits
    // à la marge dure, et rendre chaque retour à la ligne couperait chaque phrase en deux.
    const para = [line];
    for (
      let j = i + 1;
      j < lines.length &&
      lines[j].trim() &&
      !/^(#{1,6}\s|\s*(```+|~~~+)|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[j]) &&
      !/\|/.test(lines[j]);
      j += 1
    ) {
      para.push(lines[j]);
      i = j;
    }
    closeList();
    out.push(`<p>${inline(esc(para.join(' ')))}</p>`);
  }

  closeList();
  return out.join('\n');
}

/** Les étiquettes d'un document, dans l'ordre où on les lit. */
function badges(doc) {
  const out = [];
  if (doc.status) {
    out.push({ text: doc.status, cls: STATUS_CLASS[doc.status] || 'st-other' });
  }
  if (doc.type) out.push({ text: doc.type, cls: 'st-type' });
  for (const kind of doc.kinds || []) out.push({ text: kind, cls: 'st-kind' });
  return out;
}

/** Le sous-titre d'une ligne : la date, le chemin, et le nombre de schémas s'il y en a. */
function subtitle(doc) {
  const bits = [doc.date, doc.path];
  if (doc.diagrams) bits.push(`${doc.diagrams} schéma${doc.diagrams > 1 ? 's' : ''}`);
  return bits.filter(Boolean).join(' · ');
}

const plansView = { markdown, table, badges, subtitle, inline, esc, escAttr, STATUS_CLASS };
if (typeof module !== 'undefined' && module.exports) module.exports = plansView;

// --- Tout ce qui suit demande un DOM -----------------------------------------------

if (typeof document !== 'undefined') {
  const $ = (sel) => document.querySelector(sel);

  /** Amorces de diagramme proposées à la création. Les corps viennent du serveur. */
  const DIAGRAM_KINDS = [
    { id: 'mcd', label: 'MCD (entités-associations)' },
    { id: 'usecase', label: "Cas d'usage" },
    { id: 'sequence', label: 'Diagramme de séquence' },
    { id: 'classes', label: 'Diagramme de classes' },
    { id: 'etats', label: 'Diagramme d’états' },
    { id: 'flux', label: 'Flux / architecture' },
  ];

  /**
   * État du tiroir. Volontairement plat et local : ce panneau ne partage rien avec le reste de
   * l'application, et le brancher sur l'état global d'`app.js` créerait une dépendance dans
   * les deux sens pour trois champs.
   */
  const view = {
    project: null,
    tab: 'plans', // 'plans' | 'schemas'
    sections: [],
    diagrams: [],
    open: null, // le document ouvert, corps compris
    editing: false,
    dirty: false,
    loading: false,
    serverContent: '',
    draftConflict: null,
    draftRestored: false,
    draftWarning: '',
  };

  let mermaidReady = null;
  let paintSeq = 0;
  let viewSeq = 0;
  let draftTimer = null;

  function draftWarning(reason) {
    view.draftWarning =
      reason === 'too-large'
        ? 'Ce document est trop volumineux pour persister son brouillon. Il reste protégé seulement tant que cet onglet reste ouvert.'
        : reason === 'remove'
          ? "Le brouillon est abandonné ici, mais le navigateur n’a pas pu supprimer sa copie locale. Il pourrait être reproposé après un rechargement."
        : 'Le brouillon ne peut pas être conservé durablement sur cet appareil. Il reste protégé seulement tant que cet onglet reste ouvert.';
    const status = $('#doc-draft-status');
    if (status) {
      status.textContent = view.draftWarning;
      status.classList.add('error-text');
    }
  }

  const planDrafts = window.AgentHubPlanDrafts
    ? window.AgentHubPlanDrafts.create({ onWarning: draftWarning })
    : null;

  function removeDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    let removed = true;
    if (planDrafts && view.project && view.open) removed = planDrafts.remove(view.project, view.open.path);
    view.draftConflict = null;
    view.draftRestored = false;
    const status = $('#doc-draft-status');
    if (removed) {
      view.draftWarning = '';
      if (status) {
        status.textContent = '';
        status.classList.remove('error-text');
      }
    }
    return removed;
  }

  function persistDraft(content) {
    if (!view.project || !view.open || !view.dirty) return;
    if (!planDrafts) {
      draftWarning('unavailable');
      return;
    }
    const result = planDrafts.save({
      project: view.project,
      path: view.open.path,
      base: view.serverContent,
      content,
    });
    if (result.persisted) {
      view.draftWarning = '';
      const status = $('#doc-draft-status');
      if (status) {
        status.textContent = view.draftRestored ? 'Brouillon local restauré · non enregistré dans le projet' : 'Brouillon conservé sur cet appareil';
        status.classList.remove('error-text');
      }
    }
  }

  function scheduleDraft(content) {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => persistDraft(content), 300);
  }

  function flushDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    if (!view.editing || !view.open) return;
    const editor = $('#doc-editor');
    if (editor && view.dirty) persistDraft(editor.value);
  }

  window.addEventListener('pagehide', flushDraft);

  /**
   * Charge et initialise mermaid, une seule fois, **à la première ouverture du tiroir**.
   *
   * Le fichier fait 3,5 Mo : le charger dans `index.html` ferait payer ce poids à chaque
   * ouverture de l'application, y compris aux sessions qui ne regardent jamais un schéma.
   * D'où l'import à la demande, et la promesse mémorisée pour que deux ouvertures rapprochées
   * ne le téléchargent pas deux fois.
   */
  function loadMermaid() {
    if (mermaidReady) return mermaidReady;
    mermaidReady = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = '/vendor/mermaid.min.js';
      tag.onload = () => resolve(window.mermaid);
      tag.onerror = () => reject(new Error('Mermaid introuvable dans /vendor'));
      document.head.appendChild(tag);
    }).then((mermaid) => {
      mermaid.initialize({
        startOnLoad: false,
        // `securityLevel: 'strict'` interdit le HTML dans les libellés : un schéma est du
        // texte écrit par un agent, et il finit dans le DOM de l'application.
        securityLevel: 'strict',
        theme: 'dark',
        fontFamily: 'inherit',
        // Accordé à la palette de la feuille de style : un diagramme aux couleurs de mermaid
        // au milieu du thème se lit comme une capture d'écran collée là.
        themeVariables: {
          background: '#1f1e1d',
          primaryColor: '#302f2c',
          primaryTextColor: '#e9e6e0',
          primaryBorderColor: '#d97757',
          secondaryColor: '#33322e',
          tertiaryColor: '#262624',
          lineColor: '#918d85',
          textColor: '#e9e6e0',
          mainBkg: '#302f2c',
          nodeBorder: '#d97757',
          clusterBkg: '#262624',
          clusterBorder: '#3d3b37',
          actorBkg: '#302f2c',
          actorBorder: '#d97757',
          actorTextColor: '#e9e6e0',
          signalColor: '#918d85',
          signalTextColor: '#e9e6e0',
          labelBoxBkgColor: '#33322e',
          labelTextColor: '#e9e6e0',
          noteBkgColor: '#3a332e',
          noteTextColor: '#e9e6e0',
          noteBorderColor: '#d97757',
        },
      });
      return mermaid;
    });
    return mermaidReady;
  }

  /**
   * Remplace chaque conteneur `data-mermaid` d'une racine par son dessin.
   *
   * Chaque diagramme est rendu séparément et dans son propre `try` : un schéma en cours
   * d'écriture est syntaxiquement faux la moitié du temps, et une seule erreur ne doit pas
   * vider la page des autres. Le compteur `paintSeq` annule un rendu devenu inutile — on tape
   * dans l'éditeur plus vite que mermaid ne dessine.
   */
  async function paintDiagrams(root) {
    const targets = [...root.querySelectorAll('[data-mermaid]')];
    if (!targets.length) return;
    const seq = ++paintSeq;

    let mermaid;
    try {
      mermaid = await loadMermaid();
    } catch (err) {
      for (const el of targets) el.classList.add('diagram-failed');
      return;
    }
    if (seq !== paintSeq) return;

    for (let n = 0; n < targets.length; n += 1) {
      const el = targets[n];
      const code = el.dataset.mermaid;
      if (!code || !code.trim()) continue;
      try {
        const { svg } = await mermaid.render(`plans-d${seq}-${n}`, code);
        if (seq !== paintSeq) return;
        el.innerHTML = svg;
        el.classList.remove('diagram-failed');
        el.classList.add('diagram-ok');
      } catch (err) {
        if (seq !== paintSeq) return;
        // Le code source reste affiché — c'est déjà ce que contient le conteneur — et le
        // message dit ce qui cloche, ce qu'un éditeur de schéma doit faire.
        el.classList.add('diagram-failed');
        const why = document.createElement('div');
        why.className = 'diagram-error';
        why.textContent = String((err && err.message) || err).split('\n')[0];
        el.appendChild(why);
      }
    }
  }

  // --- Appels au serveur ----------------------------------------------------

  function convId() {
    // L'identifiant de la conversation courante appartient à `app.js` ; il l'expose pour ce
    // tiroir, qui ne connaît le projet que par elle.
    return window.currentConvId ? window.currentConvId() : null;
  }

  async function call(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  }

  // --- Rendu ----------------------------------------------------------------

  function setCount() {
    const el = $('#plans-count');
    if (!el) return;
    if (view.loading) {
      el.textContent = 'lecture…';
      return;
    }
    if (view.open) {
      el.textContent = view.editing ? 'édition' : view.open.path;
      return;
    }
    if (view.tab === 'schemas') {
      const n = view.diagrams.length;
      el.textContent = n ? `${n} schéma${n > 1 ? 's' : ''}` : 'aucun schéma';
      return;
    }
    const n = view.sections.reduce((t, s) => t + s.docs.length, 0);
    el.textContent = n ? `${n} document${n > 1 ? 's' : ''}` : 'aucun document';
  }

  /**
   * Une ligne de la liste : un bouton pour ouvrir, un bouton pour actualiser.
   *
   * Deux boutons **frères** et non l'un dans l'autre : un `<button>` imbriqué dans un `<button>`
   * est invalide, et les navigateurs s'en sortent en n'envoyant jamais le clic du plus petit —
   * le bouton « Mettre à jour » aurait simplement ouvert le document.
   */
  function row(doc) {
    return (
      `<div class="plans-row">` +
      `<button class="plans-row-main" data-open="${escAttr(doc.path)}">` +
      `<span class="plans-row-title">${esc(doc.title)}</span>` +
      `<span class="plans-row-tags">${badges(doc)
        .map((b) => `<span class="plans-tag ${b.cls}">${esc(b.text)}</span>`)
        .join('')}</span>` +
      `<span class="plans-row-sub">${esc(subtitle(doc))}</span>` +
      `</button>` +
      `<button class="plans-maj" data-maj="${escAttr(doc.path)}" ` +
      `title="Demander à l'agent de mettre ce document à jour">Mettre à jour</button>` +
      `</div>`
    );
  }

  function renderList() {
    const body = $('#plans-body');
    if (!view.sections.length) {
      body.innerHTML =
        '<div class="empty">Aucun plan dans ce projet.<br>' +
        'Le bouton + en crée un dans <code>docs/plans/</code>.</div>';
      return;
    }
    body.innerHTML = view.sections
      .map(
        (section) =>
          `<div class="plans-section"><div class="plans-section-head">${esc(section.label)}` +
          `<span>${section.docs.length}</span></div>` +
          section.docs.map((doc) => row(doc)).join('') +
          '</div>'
      )
      .join('');
  }

  function renderDiagramList() {
    const body = $('#plans-body');
    if (!view.diagrams.length) {
      body.innerHTML =
        '<div class="empty">Aucun schéma dans ce projet.<br>' +
        'Le bouton + en crée un — MCD, cas d’usage, séquence…</div>';
      return;
    }
    body.innerHTML = view.diagrams
      .map(
        (d) =>
          `<div class="plans-card">` +
          `<button class="plans-card-main" data-open="${escAttr(d.path)}" data-block="${d.index}">` +
          `<span class="plans-card-head">` +
          `<span class="plans-tag st-kind">${esc(d.kind)}</span>` +
          `<span class="plans-card-title">${esc(d.title || d.docTitle || d.name)}</span>` +
          `</span>` +
          `<figure class="doc-diagram plans-thumb" data-mermaid="${escAttr(d.code)}">` +
          `<pre class="doc-diagram-src">${esc(d.code)}</pre></figure>` +
          `<span class="plans-row-sub">${esc(d.path)}${d.standalone ? '' : ' · dans un plan'}</span>` +
          `</button>` +
          // Le titre du bloc part avec le chemin : un plan qui porte deux diagrammes rendrait
          // sinon la consigne ambiguë, et l'agent actualiserait celui qu'il trouve en premier.
          `<button class="plans-maj" data-maj="${escAttr(d.path)}" ` +
          `data-maj-diagram="${escAttr(d.kind)}" ` +
          `data-maj-title="${escAttr(d.title || d.docTitle || '')}" ` +
          `title="Demander à l'agent de mettre ce schéma à jour">Mettre à jour</button>` +
          `</div>`
      )
      .join('');
    paintDiagrams(body);
  }

  function renderDoc() {
    const doc = view.open;
    const body = $('#plans-body');
    const meta = badges(doc)
      .map((b) => `<span class="plans-tag ${b.cls}">${esc(b.text)}</span>`)
      .join('');
    const conflict = view.draftConflict
      ? `<div class="doc-draft-banner conflict" role="status">
          <div><strong>Le document a changé depuis ce brouillon local.</strong>
          <p>La version du projet reste affichée. Reprendre le brouillon est un choix explicite : son prochain enregistrement remplacera cette version.</p></div>
          <div class="doc-draft-actions"><button class="secondary" data-doc-draft-discard>Abandonner le brouillon</button><button class="primary" data-doc-draft-resume>Reprendre mon brouillon</button></div>
        </div>`
      : '';
    const storageWarning = !view.editing && view.draftWarning
      ? `<div class="doc-draft-banner warning" role="status">${esc(view.draftWarning)}</div>`
      : '';

    if (view.editing) {
      body.innerHTML =
        storageWarning + conflict + `<div class="doc-view">` +
        `<div class="doc-head"><h2>${esc(doc.title)}</h2><div class="doc-tags">${meta}</div>` +
        `<div class="plans-row-sub">${esc(doc.path)}</div></div>` +
        `<textarea id="doc-editor" class="doc-editor" spellcheck="false"></textarea>` +
        `<div class="doc-edit-foot">` +
        `<span id="doc-error" class="error-text"></span>` +
        `<span id="doc-hint" class="plans-row-sub">Ctrl+S enregistre</span>` +
        `<span id="doc-draft-status" class="plans-row-sub${view.draftWarning ? ' error-text' : ''}">${esc(
          view.draftWarning || (view.draftRestored ? 'Brouillon local restauré · non enregistré dans le projet' : '')
        )}</span>` +
        `${view.draftRestored ? '<button data-doc-draft-discard class="secondary">Abandonner le brouillon</button>' : ''}` +
        `<button id="btn-doc-cancel" class="secondary">Annuler</button>` +
        `<button id="btn-doc-save" class="primary">Enregistrer</button>` +
        `</div>` +
        // L'aperçu sous l'éditeur, et non à côté : le tiroir fait 420 px par défaut, deux
        // colonnes y donneraient deux colonnes illisibles.
        `<div class="doc-preview" id="doc-preview"></div>` +
        `</div>`;
      const editor = $('#doc-editor');
      editor.value = doc.content;
      editor.addEventListener('input', () => {
        view.dirty = editor.value !== view.serverContent;
        if (view.dirty) scheduleDraft(editor.value);
        else removeDraft();
        schedulePreview();
      });
      editor.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          saveDoc();
        }
      });
      schedulePreview();
      return;
    }

    body.innerHTML =
      storageWarning + conflict + `<div class="doc-view">` +
      `<div class="doc-head"><h2>${esc(doc.title)}</h2><div class="doc-tags">${meta}</div>` +
      `<div class="plans-row-sub">${esc(doc.path)}${doc.origin ? ` · vient de ${esc(doc.origin)}` : ''}</div>` +
      // Le même geste depuis le document ouvert : c'est en le lisant qu'on s'aperçoit qu'il
      // est périmé, pas en parcourant la liste.
      `<button class="plans-maj doc-maj" data-maj="${escAttr(doc.path)}"` +
      `${doc.mermaid ? ` data-maj-diagram="${esc((doc.kinds || [])[0] || 'schéma')}"` : ''}` +
      ` title="Demander à l'agent de mettre ce document à jour">Mettre à jour</button>` +
      `</div>` +
      `<div class="doc-md">${
        doc.mermaid
          ? `<figure class="doc-diagram" data-mermaid="${escAttr(doc.content)}">` +
            `<pre class="doc-diagram-src">${esc(doc.content)}</pre></figure>`
          : markdown(doc.content)
      }</div>` +
      `</div>`;
    paintDiagrams(body);
  }

  /**
   * Aperçu différé pendant la frappe.
   *
   * Un schéma se corrige en tapant, et mermaid met des dizaines de millisecondes à dessiner :
   * rendre à chaque touche ferait ramer le champ. 350 ms est le compromis observé — assez court
   * pour que l'aperçu suive la pensée, assez long pour ne pas dessiner un mot sur deux.
   */
  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const editor = $('#doc-editor');
      const target = $('#doc-preview');
      if (!editor || !target) return;
      const text = editor.value;
      // Enveloppé dans `.doc-md` comme la vue de lecture : les styles des blocs de code, des
      // liens et du code en ligne y sont attachés, et l'aperçu doit montrer le rendu final.
      target.innerHTML =
        `<div class="doc-md">${
          view.open.mermaid
            ? `<figure class="doc-diagram" data-mermaid="${escAttr(text)}">` +
              `<pre class="doc-diagram-src">${esc(text)}</pre></figure>`
            : markdown(text)
        }</div>`;
      paintDiagrams(target);
    }, 350);
  }

  function render() {
    setCount();
    $('#plans-tabs').classList.toggle('hidden', Boolean(view.open));
    $('#btn-plans-back').classList.toggle('hidden', !view.open);
    $('#btn-plans-new').classList.toggle('hidden', Boolean(view.open));
    $('#btn-plans-edit').classList.toggle('hidden', !view.open || view.editing || Boolean(view.draftConflict));

    for (const tab of document.querySelectorAll('[data-plans-tab]')) {
      tab.classList.toggle('active', tab.dataset.plansTab === view.tab);
    }

    if (view.loading) {
      $('#plans-body').innerHTML = '<div class="empty">Lecture du projet…</div>';
      return;
    }
    if (view.open) return renderDoc();
    if (view.tab === 'schemas') return renderDiagramList();
    renderList();
  }

  // --- Chargements ----------------------------------------------------------

  async function loadList() {
    // Certaines entrées (réouverture du tiroir, changement de panneau) peuvent revenir à la
    // liste sans passer par le bouton Retour. Persister avant de remplacer le DOM ferme cette
    // dernière fenêtre de perte entre une frappe et le délai d'écriture du brouillon.
    flushDraft();
    const seq = ++viewSeq;
    const id = convId();
    if (!id) return;
    view.loading = true;
    view.open = null;
    view.editing = false;
    render();
    try {
      if (view.tab === 'schemas') {
        const data = await call(`/api/plans/diagrams?${new URLSearchParams({ convId: id })}`);
        if (seq !== viewSeq || convId() !== id) return;
        view.project = data.project;
        view.diagrams = data.diagrams || [];
      } else {
        const data = await call(`/api/plans?${new URLSearchParams({ convId: id })}`);
        if (seq !== viewSeq || convId() !== id) return;
        view.project = data.project;
        view.sections = data.sections || [];
      }
    } catch (err) {
      if (seq !== viewSeq || convId() !== id) return;
      view.loading = false;
      $('#plans-body').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      setCount();
      return;
    }
    view.loading = false;
    render();
  }

  async function openDoc(path, blockIndex) {
    const seq = ++viewSeq;
    const id = convId();
    if (!id) return;
    view.loading = true;
    render();
    try {
      const data = await call(
        `/api/plans/doc?${new URLSearchParams({ convId: id, path })}`
      );
      if (seq !== viewSeq || convId() !== id) return;
      clearTimeout(draftTimer);
      draftTimer = null;
      view.open = data.doc;
      view.editing = false;
      view.dirty = false;
      view.serverContent = data.doc.content;
      view.draftConflict = null;
      view.draftRestored = false;
      view.draftWarning = '';
      const local = planDrafts ? planDrafts.load(view.project, data.doc.path) : null;
      if (local && local.persisted === false) draftWarning('unavailable');
      if (local && local.content === data.doc.content) {
        // Un brouillon identique à la version serveur n'a plus rien à protéger.
        planDrafts.remove(view.project, data.doc.path);
      } else if (local && planDrafts.relation(local, data.doc.content) === 'same-base') {
        view.open = { ...data.doc, content: local.content };
        view.editing = true;
        view.dirty = true;
        view.draftRestored = true;
      } else if (local) {
        // On garde les deux versions séparées jusqu'au choix explicite sous le document.
        view.draftConflict = local;
      }
      view.loading = false;
      render();
      // Ouvrir une carte de schéma doit amener sur ce schéma, pas en haut d'un plan de dix pages.
      if (blockIndex != null && !view.open.mermaid) {
        const figures = $('#plans-body').querySelectorAll('.doc-diagram');
        const target = figures[Number(blockIndex)];
        if (target) target.scrollIntoView({ block: 'center' });
      }
    } catch (err) {
      if (seq !== viewSeq || convId() !== id) return;
      view.loading = false;
      view.open = null;
      render();
      window.toastError(err.message);
    }
  }

  async function saveDoc() {
    const editor = $('#doc-editor');
    if (!editor || !view.open) return;
    const btn = $('#btn-doc-save');
    if (!btn || btn.disabled) return;
    const seq = viewSeq;
    const id = convId();
    if (!id) return;
    const content = editor.value;
    // Le clic Enregistrer ne rend pas le réseau plus fiable : le brouillon local reste la
    // ceinture de sécurité jusqu'à la confirmation de l'API.
    view.dirty = content !== view.serverContent;
    if (view.dirty) persistDraft(content);
    btn.disabled = true;
    try {
      // Le fichier peut avoir été modifié par un agent ou un autre onglet pendant l'édition.
      // Une relecture légère avant l'écriture garde les deux versions séparées au lieu de
      // remplacer silencieusement celle du projet.
      const latest = await call(
        `/api/plans/doc?${new URLSearchParams({ convId: id, path: view.open.path })}`
      );
      if (seq !== viewSeq || convId() !== id) return;
      if (latest.doc.content !== view.serverContent) {
        view.dirty = true;
        persistDraft(editor.value);
        const local = planDrafts ? planDrafts.load(view.project, view.open.path) : null;
        view.open = latest.doc;
        view.serverContent = latest.doc.content;
        view.editing = false;
        view.dirty = false;
        view.draftRestored = false;
        view.draftConflict = local;
        render();
        window.toastError('Le document a changé ailleurs. Les deux versions sont conservées : choisis celle à reprendre.');
        return;
      }
      const data = await call('/api/plans/doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          convId: id,
          project: view.project,
          path: view.open.path,
          content,
          // Le serveur compare cette version atomiquement au moment de l'écriture : une
          // modification arrivée après le GET de préflight produit un 409 et laisse le
          // brouillon local intact dans le catch ci-dessous.
          expectedVersion: latest.doc.version,
        }),
      });
      if (seq !== viewSeq || convId() !== id) return;
      // Le textarea reste éditable pendant le réseau. Une frappe plus récente ne doit pas
      // être marquée enregistrée ni disparaître au retour de la réponse précédente.
      if (editor.value !== content) {
        view.serverContent = data.doc.content;
        view.open = { ...data.doc, content: editor.value };
        view.dirty = true;
        view.draftRestored = false;
        persistDraft(editor.value);
        btn.disabled = false;
        const hint = $('#doc-hint');
        if (hint) hint.textContent = 'Version précédente enregistrée · nouvelles modifications en attente';
        return;
      }
      view.open = data.doc;
      view.serverContent = data.doc.content;
      view.editing = false;
      view.dirty = false;
      removeDraft();
      render();
      window.toast('Enregistré');
    } catch (err) {
      if (seq !== viewSeq || convId() !== id) return;
      view.dirty = editor.value !== view.serverContent;
      if (view.dirty) persistDraft(editor.value);
      btn.disabled = false;
      const box = $('#doc-error');
      if (box) box.textContent = err.message;
      else window.toastError(err.message);
    }
  }

  /**
   * Création : une nature, un titre, et pour un schéma une amorce.
   *
   * L'amorce est le point qui décide si la seconde moitié de la fonctionnalité sert : la
   * syntaxe mermaid d'un MCD ne se devine pas, et partir d'un exemple complet qu'on remplace
   * est la différence entre « je fais mon schéma » et « j'ouvre la documentation de mermaid ».
   */
  async function createDoc() {
    const kinds = [
      { id: 'plan', label: 'Plan' },
      { id: 'cadrage', label: 'Cadrage / spec' },
      { id: 'schema', label: 'Schéma' },
    ];
    let kind = 'plan';
    let titleInput = null;
    let diagramSelect = null;

    const ok = await window.openDialog({
      title: 'Nouveau document',
      cancelValue: null,
      buildBody: (bodyEl) => {
        const pick = document.createElement('div');
        pick.className = 'pick';
        for (const k of kinds) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `pick-btn${k.id === kind ? ' active' : ''}`;
          btn.textContent = k.label;
          btn.dataset.kind = k.id;
          pick.appendChild(btn);
        }
        bodyEl.appendChild(pick);

        const field = document.createElement('div');
        field.className = 'relay-field';
        const label = document.createElement('label');
        label.className = 'relay-label';
        label.textContent = 'Titre';
        titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.placeholder = 'MCD de la boutique';
        field.append(label, titleInput);
        bodyEl.appendChild(field);

        const diagramField = document.createElement('div');
        diagramField.className = 'relay-field hidden';
        const diagramLabel = document.createElement('label');
        diagramLabel.className = 'relay-label';
        diagramLabel.textContent = 'Type de schéma';
        diagramSelect = document.createElement('select');
        for (const d of DIAGRAM_KINDS) {
          const opt = document.createElement('option');
          opt.value = d.id;
          opt.textContent = d.label;
          diagramSelect.appendChild(opt);
        }
        diagramField.append(diagramLabel, diagramSelect);
        bodyEl.appendChild(diagramField);

        const note = document.createElement('p');
        note.className = 'dialog-p';
        note.textContent =
          "Un schéma est créé avec un exemple complet et valide, qu'il suffit de remplacer.";
        bodyEl.appendChild(note);

        pick.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-kind]');
          if (!btn) return;
          kind = btn.dataset.kind;
          for (const b of pick.querySelectorAll('[data-kind]')) {
            b.classList.toggle('active', b === btn);
          }
          diagramField.classList.toggle('hidden', kind !== 'schema');
          note.classList.toggle('hidden', kind !== 'schema');
        });
        note.classList.add('hidden');
      },
      buttons: [
        { label: 'Annuler', value: null },
        { label: 'Créer', value: true, primary: true },
      ],
      focus: () => titleInput,
    });
    if (!ok) return;

    const title = titleInput.value.trim();
    if (!title) return window.toastError('Titre manquant');
    const diagram = diagramSelect.value;
    const seq = viewSeq;
    const id = convId();
    const project = view.project;
    if (!id) return;

    try {
      const data = await call('/api/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          convId: id,
          project,
          kind,
          title,
          diagram,
        }),
      });
      if (seq !== viewSeq || convId() !== id) return;
      window.toast(`Créé : ${data.doc.path}`);
      // On enchaîne dans l'éditeur : créer un document pour ensuite le chercher dans une liste
      // serait un clic de trop sur le geste le plus fréquent.
      view.open = data.doc;
      view.editing = true;
      view.dirty = false;
      view.serverContent = data.doc.content;
      view.draftConflict = null;
      view.draftRestored = false;
      view.draftWarning = '';
      render();
    } catch (err) {
      if (seq === viewSeq && convId() === id) window.toastError(err.message);
    }
  }

  // --- Câblage --------------------------------------------------------------

  /**
   * Nom de la skill d'actualisation. Elle est **globale** — `~/.claude/skills/` — donc
   * disponible dans tous les projets, et dépliée par agentHub lui-même pour les fournisseurs
   * qui ne savent pas le faire (voir `lib/skills.js`).
   */
  const MAJ_SKILL = 'plan-actualiser';

  /**
   * Le bouton « Mettre à jour » **remplit le composeur, il n'envoie pas**.
   *
   * C'est le point de conception du bouton. On veut presque toujours ajouter une phrase avant
   * de lancer — « le relais a changé », « ajoute l'étape des worktrees » — et un bouton qui
   * partirait au clic ferait deviner à l'agent ce qui a bougé. Il porte donc le chemin, ce qui
   * lui évite de chercher le bon document, et laisse la main sur le reste.
   */
  function composeMaj(path, diagramKind, diagramTitle) {
    if (!window.composeInto) return;
    const what = diagramKind
      ? `le schéma${diagramTitle ? ` « ${diagramTitle} »` : ''} (${diagramKind}) de \`${path}\``
      : `le document \`${path}\``;
    // Le chemin suit la skill sur la première ligne : c'est l'argument, et il évite à l'agent
    // de chercher lequel des documents du projet on veut. La phrase reste ouverte — le curseur
    // atterrit au bout, prêt pour « parce que le relais a changé ».
    window.composeInto(`/${MAJ_SKILL} ${path}\n\nMets ${what} à jour. `);
  }

  $('#plans-body').addEventListener('click', (e) => {
    const maj = e.target.closest('[data-maj]');
    if (maj) return composeMaj(maj.dataset.maj, maj.dataset.majDiagram, maj.dataset.majTitle);
    const row = e.target.closest('[data-open]');
    if (!row) return;
    openDoc(row.dataset.open, row.dataset.block);
  });

  $('#plans-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-plans-tab]');
    if (!tab || tab.dataset.plansTab === view.tab) return;
    view.tab = tab.dataset.plansTab;
    loadList();
  });

  $('#btn-plans-back').addEventListener('click', () => {
    // Revenir à la liste n'écrit rien dans le projet et ne demande plus une confirmation à
    // chaque fois : le brouillon local est le filet de sécurité explicite.
    flushDraft();
    loadList();
  });

  $('#btn-plans-edit').addEventListener('click', () => {
    if (!view.open) return;
    if (view.open.tooBig) return window.toastError('Document trop volumineux pour être édité ici');
    view.serverContent = view.open.content;
    view.draftConflict = null;
    view.draftRestored = false;
    view.draftWarning = '';
    view.editing = true;
    render();
  });

  $('#btn-plans-new').addEventListener('click', createDoc);
  $('#btn-plans-refresh').addEventListener('click', () => {
    if (view.open) {
      flushDraft();
      return openDoc(view.open.path);
    }
    loadList();
  });

  $('#plans-body').addEventListener('click', (e) => {
    if (e.target.closest('#btn-doc-save')) return saveDoc();
    if (e.target.closest('[data-doc-draft-resume]') && view.draftConflict) {
      const local = view.draftConflict;
      view.draftConflict = null;
      view.draftRestored = true;
      view.open = { ...view.open, content: local.content };
      view.editing = true;
      view.dirty = local.content !== view.serverContent;
      // Ce clic reconnaît explicitement la version serveur actuelle comme nouvelle base.
      if (view.dirty) persistDraft(local.content);
      else removeDraft();
      render();
      return;
    }
    if (e.target.closest('[data-doc-draft-discard]')) {
      removeDraft();
      view.open = { ...view.open, content: view.serverContent };
      view.editing = false;
      view.dirty = false;
      render();
      return;
    }
    if (e.target.closest('#btn-doc-cancel')) {
      removeDraft();
      view.open = { ...view.open, content: view.serverContent };
      view.editing = false;
      view.dirty = false;
      render();
    }
  });

  /**
   * Ce que le tiroir expose à `app.js` : ouvrir, fermer, et se rafraîchir quand le serveur
   * annonce un changement. Le reste — quel onglet, quel document — ne regarde que lui.
   */
  window.plansPanel = {
    open() {
      loadList();
    },
    close() {
      flushDraft();
      viewSeq += 1;
      view.open = null;
      view.editing = false;
      view.dirty = false;
      view.serverContent = '';
      view.draftConflict = null;
      view.draftRestored = false;
      view.draftWarning = '';
    },
    /** Un autre onglet a écrit dans ce projet : la liste affichée n'est plus à jour. */
    onServerChange(project) {
      const panel = $('#plans-panel');
      if (!panel || panel.classList.contains('hidden')) return;
      if (view.project && project && view.project !== project) return;
      // Ne pas écraser une édition en cours sous les doigts de l'utilisateur.
      if (view.editing) return;
      if (view.open) return;
      loadList();
    },
  };
}
