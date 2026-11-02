'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  convs: [],
  currentId: null,
  current: null,
  isRunning: false,
  provider: 'claude',
  search: '',
  models: null,
  // Skills du fournisseur ouvert. `skillsOf` retient pour qui, afin de ne pas recharger le
  // catalogue à chaque conversation du même agent.
  skills: [],
  skillsOf: null,
  skillFound: [],
  skillPick: -1,
  newFolderParents: [],
  // Chemins des projets versionnés, seuls à pouvoir recevoir une branche isolée.
  gitProjects: new Set(),
  // Bloc-notes du projet ouvert. `notesProject` est la clé côté serveur — le dépôt, et non
  // le worktree quand la conversation est isolée.
  notes: [],
  notesProject: null,
  // Questions en attente de **toutes** les conversations, pour le badge de l'onglet.
  // `ask` ci-dessus ne concerne que la conversation ouverte.
  pendingAsks: [],
  // Modèles de consigne, rechargés à l'ouverture du tiroir et sur diffusion du serveur.
  prompts: [],
  // Règles du projet dont la modale est ouverte.
  rules: [],
  // Turns en cours qui n'écrivent plus rien. Le serveur envoie `since` et non une durée : la
  // liste n'est rediffusée que quand elle change, et c'est ici qu'on recalcule l'âge.
  silent: [],
  usageMonth: 'all',
  queue: [],
  // Question d'arbitrage en attente sur la conversation ouverte. Elle vient du serveur, pas
  // du navigateur : elle doit survivre à un rechargement et se voir depuis un autre appareil.
  ask: null,
  folders: [],
  // Conversations supprimées à l'écran mais dont l'appel est encore retenu derrière un
  // « Annuler ». Filtrées à l'affichage plutôt que masquées en CSS : la barre latérale se
  // repeint à chaque événement du websocket, et une ligne cachée par une classe
  // réapparaîtrait au premier avis reçu pendant les six secondes d'attente.
  hiding: new Set(),
  triggers: [],
  frequencies: [],
  // Historiques d'exécution dépliés. La vue Déclencheurs est réaffichée à chaque écriture
  // du planificateur ; sans mémoire, l'historique se refermerait sous les yeux de qui le
  // consulte, et justement au moment le plus intéressant — quand un déclencheur part.
  openRuns: new Set(),
  deep: null, // resultats de la recherche dans le contenu, cote serveur
  galProjects: [],
  galImages: [],
  accounts: null, // null tant que /api/accounts n'a pas répondu
  // Réglages modifiables, tels que le serveur les rend : valeurs effectives par section,
  // plus la liste de ce qui s'écarte du dépôt. null tant que la page n'a pas été ouverte.
  settings: null,
};

// --- Utilitaires ----------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Comme `esc`, plus les guillemets. À utiliser dès qu'un texte d'agent finit dans un
 * attribut : un titre d'idée contient un guillemet une fois sur dix, et sans ça il ferme
 * l'attribut et laisse le reste de la phrase devenir du balisage.
 */
function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;');
}

/**
 * Identifiant utilisable dans un sélecteur CSS. Sert à retrouver la ligne qu'une
 * suppression fait disparaître le temps qu'on puisse l'annuler.
 */
function cssEscape(s) {
  const raw = String(s == null ? '' : s);
  return window.CSS && CSS.escape ? CSS.escape(raw) : raw.replace(/["\\]/g, '\\$&');
}

/**
 * Mise en forme dans une ligne : code, gras, italique. Sur du texte **déjà échappé**.
 *
 * À part parce que deux rendus s'en servent — le fil, et les cartes d'idée qui en sont
 * extraites avant qu'il ne passe. Sans ça, une description d'idée affichait ses backticks.
 */
function inline(escaped) {
  return escaped
    .replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

// Rendu markdown volontairement minimal : blocs de code, code inline, gras,
// italique et listes. Suffisant pour de la sortie d'agent, zéro dépendance.
function md(text) {
  const blocks = [];
  let src = String(text || '').replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code data-lang="${esc(lang)}">${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  // Images markdown produites par un agent : ![alt](chemin). Le chemin est
  // resolu cote serveur (relatif au dossier de travail, au dossier de session du
  // provider, ou absolu) : le navigateur le resoudrait contre l'origine de l'app.
  src = src.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, target) => {
    const url = /^https?:\/\//i.test(target)
      ? target
      : `/api/conversations/${state.currentId}/image?path=${encodeURIComponent(target)}`;
    blocks.push(
      `<img class="msg-img" src="${esc(url)}" alt="${esc(alt)}" title="${esc(target)}" ` +
        `data-image="${esc(url)}" data-name="${esc(alt || target)}" data-path="${esc(target)}" loading="lazy">`
    );
    return `\u0000${blocks.length - 1}\u0000`;
  });

  // Idées proposées par l'agent : `[idée] Titre — description`. Extraites AVANT
  // l'échappement et la mise en forme, pour que le titre porté par la carte soit le texte
  // brut — c'est lui qui partira dans la todo, et du `<strong>` dans un titre de ticket
  // serait un dégât silencieux.
  src = src.replace(new RegExp(ideas.IDEA_LINE.source, 'gim'), (line) => {
    const idea = ideas.match(line);
    if (!idea) return line;
    blocks.push(
      `<div class="idea">` +
        `<svg class="icon"><use href="#i-note"/></svg>` +
        // Affichage mis en forme, attributs bruts : c'est le titre brut qui part dans la
        // todo, et du `<code>` dans un titre de ticket serait un dégât silencieux.
        `<div class="idea-text"><strong>${inline(esc(idea.title))}</strong>` +
        (idea.body ? `<span>${inline(esc(idea.body))}</span>` : '') +
        `</div>` +
        // « Faire » avant « Ajouter à la todo », et c'est délibéré : la todo est ce qu'on
        // choisit quand on ne veut pas maintenant. Le cas fréquent est l'inverse — on lit une
        // proposition et on la veut tout de suite, sans la retaper.
        `<button class="idea-do" data-idea-title="${escAttr(idea.title)}" ` +
        `data-idea-body="${escAttr(idea.body)}">Faire</button>` +
        `<button class="idea-add" data-idea-title="${escAttr(idea.title)}" ` +
        `data-idea-body="${escAttr(idea.body)}">Ajouter à la todo</button>` +
        `</div>`
    );
    // Isolée par des lignes vides : la carte est un bloc, et laissée au milieu d'une liste
    // elle se retrouverait dans un `<li>` ou un `<p>` dont elle sortirait de travers.
    return `\n\n\u0000${blocks.length - 1}\u0000\n\n`;
  });

  src = inline(esc(src));

  // Un bloc, c'est ce qui est séparé par une ligne vide — sauf qu'un agent colle
  // volontiers une liste sous un titre sans sauter de ligne. On isole donc les titres et
  // on retraite ce qui les entoure, faute de quoi cette liste serait perdue.
  const renderBlock = (para) => {
    const lines = para.split('\n');

    const at = lines.findIndex((l) => /^#{1,4}\s+\S/.test(l));
    if (at !== -1) {
      const [, hashes, title] = lines[at].match(/^(#{1,4})\s+(.+)$/);
      // h1 reste à l'application : un titre d'agent commence à h2.
      const level = hashes.length + 1;
      return (
        renderBlock(lines.slice(0, at).join('\n')) +
        `<h${level} class="md-h">${title}</h${level}>` +
        renderBlock(lines.slice(at + 1).join('\n'))
      );
    }

    if (!para.trim()) return '';

    // Un bloc qui n'est que des marqueurs — carte d'idée, bloc de code, image — sort tel
    // quel. Enveloppé dans un `<p>`, un `<div>` en ressortirait de travers : le navigateur
    // ferme le paragraphe avant lui et laisse une balise orpheline derrière.
    if (lines.every((l) => !l.trim() || /^\u0000\d+\u0000$/.test(l.trim()))) {
      return lines.map((l) => l.trim()).join('');
    }

    if (lines.every((l) => /^\s*[-*+]\s+/.test(l))) {
      return `<ul class="ul">${lines
        .map((l) => `<li>${l.replace(/^\s*[-*+]\s+/, '')}</li>`)
        .join('')}</ul>`;
    }
    // Listes numérotées, bornées à trois chiffres pour ne pas transformer « 2026. » en
    // début de liste.
    if (lines.every((l) => /^\s*\d{1,3}[.)]\s+/.test(l))) {
      return `<ol class="ul">${lines
        .map((l) => `<li>${l.replace(/^\s*\d{1,3}[.)]\s+/, '')}</li>`)
        .join('')}</ol>`;
    }
    return `<p>${lines.join('<br>')}</p>`;
  };

  const html = src.split(/\n{2,}/).map(renderBlock).join('');

  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

const PROVIDER_ICONS = { claude: 'ico-claude', codex: 'ico-codex', grok: 'ico-grok' };

function providerIcon(provider) {
  const id = PROVIDER_ICONS[provider] || 'ico-claude';
  return `<svg class="pv pv-${provider}" viewBox="0 0 24 24" title="${provider}"><use href="#${id}"/></svg>`;
}

function statusLabel(status) {
  return {
    working: 'travaille',
    done: 'terminé',
    idle: 'en attente',
    error: 'erreur',
    stopped: 'interrompu',
  }[status] || status;
}

/** Entrée de silence d'une conversation, s'il y en a une. */
function silenceOf(convId) {
  return (state.silent || []).find((t) => t.convId === convId) || null;
}

/**
 * Depuis combien de temps cet agent n'écrit plus rien.
 *
 * Recalculé à l'affichage depuis `since` : le serveur ne rediffuse la liste que lorsqu'elle
 * change, donc le `idleMs` reçu vieillit. Un rendu qui l'afficherait tel quel figerait le
 * compteur à « 10 min » pour une heure de silence.
 */
function silenceLabel(entry) {
  const since = Date.parse(entry && entry.since);
  const ms = Number.isFinite(since) ? Math.max(0, Date.now() - since) : entry.idleMs || 0;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `silencieux depuis ${minutes} min`;
  const rest = minutes % 60;
  return `silencieux depuis ${Math.floor(minutes / 60)} h${rest ? ` ${String(rest).padStart(2, '0')}` : ''}`;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// --- Sidebar --------------------------------------------------------------

// Préférences d'affichage : locales au navigateur, contrairement aux données de
// conversation. Filtrer depuis le téléphone ne doit pas filtrer le PC.
const PREFS = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(`ah.${key}`);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(`ah.${key}`, JSON.stringify(value));
    } catch {
      /* navigation privée : on se contente de la session */
    }
  },
};

const ALL_PROVIDERS = ['claude', 'codex', 'grok'];

// --- Comptes connectés ------------------------------------------------------
//
// Personne n'est censé avoir les trois abonnements : un fournisseur auquel on n'est pas
// connecté ne doit pas être proposé, ni signalé comme une erreur. Mais une conversation
// déjà ouverte sur ce fournisseur reste lisible — la masquer ferait disparaître du
// travail passé pour une raison qui ne le concerne pas.

const PROVIDER_LABELS = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok' };

function providerStatus(provider) {
  return (state.accounts && state.accounts[provider]) || null;
}

/** Peut-on lancer un nouveau turn avec ce fournisseur ? */
function providerUsable(provider) {
  const s = providerStatus(provider);
  // Tant que les comptes ne sont pas chargés, on ne masque rien : une interface qui se
  // vide une seconde au démarrage est pire qu'un bouton qui échoue.
  if (!state.accounts) return true;
  return Boolean(s && (s.state === 'online' || s.state === 'unknown'));
}

function usableProviders() {
  return ALL_PROVIDERS.filter(providerUsable);
}

/** Fournisseurs à montrer dans le filtre : les utilisables, plus ceux déjà utilisés. */
function knownProviders() {
  const used = new Set(state.convs.map((c) => c.provider));
  return ALL_PROVIDERS.filter((p) => providerUsable(p) || used.has(p));
}
const hiddenProviders = new Set(PREFS.read('hiddenProviders', []));

/**
 * Menu de navigation replié en rangée d'icônes.
 *
 * Retenu par appareil, comme la largeur des tiroirs : sur un téléphone la hauteur est bien
 * plus rare que sur un écran de PC, et le même réglage pour les deux servirait mal les deux.
 */
function foldNav(folded) {
  $('.side-nav').classList.toggle('folded', folded);
  $('#btn-nav-fold').classList.toggle('folded', folded);
  $('#btn-nav-fold').setAttribute('aria-expanded', String(!folded));
  $('#btn-nav-fold').title = folded ? 'Déplier le menu' : 'Replier le menu';
  PREFS.write('navFolded', folded);
}

foldNav(PREFS.read('navFolded', false));

$('#btn-nav-fold').addEventListener('click', () =>
  foldNav(!$('.side-nav').classList.contains('folded'))
);
const collapsed = new Set(PREFS.read('collapsed', []));

function convRow(c, kidCount, depth) {
  const unread = c.status === 'done' || c.status === 'error' ? ' unread' : '';
  const active = c.id === state.currentId ? ' active' : '';
  const pin = c.pinned ? '<svg class="pin-mark"><use href="#i-pin"/></svg>' : '';

  const chev = kidCount
    ? `<span class="kid-chev${
        collapsed.has(`conv:${c.id}`) ? ' closed' : ''
      }" data-toggle-kids="${c.id}" role="button" tabindex="-1" title="${kidCount} dérivée${
        kidCount > 1 ? 's' : ''
      }"></span>`
    : '';

  // Provenance : uniquement sur une ligne racine. Sous son parent, l'imbrication la dit
  // déjà. À la racine — parent masqué par le filtre, ou enfant épinglé — il faut l'écrire,
  // sinon la conversation semble orpheline.
  const parent = depth === 0 && c.parentId ? state.convs.find((p) => p.id === c.parentId) : null;
  const from = parent
    ? `<span class="conv-from">↳ ${providerIcon(parent.provider)}${esc(parent.title)}</span>`
    : '';
  const origin = parent ? ` — dérivée de ${esc(parent.title)}` : '';

  // Une question en attente sur cette conversation. C'est la seule chose que la sidebar dit
  // du contenu d'une conversation, et elle le mérite : le badge de l'onglet signale qu'une
  // question existe, il ne dit pas laquelle la pose.
  const asked = (state.pendingAsks || []).some((a) => a.convId === c.id);
  const askMark = asked
    ? '<span class="conv-ask" title="Cet agent attend une réponse">?</span>'
    : '';

  // Turn muet. Sur la pastille elle-même, et non à côté : ce qu'il faut corriger, c'est
  // justement ce que la pastille laisse croire — qu'un agent qui pulse travaille.
  const mute = silenceOf(c.id);
  const muteMark = mute ? ' muted' : '';
  const muteTitle = mute ? ` — ${silenceLabel(mute)}` : '';

  // `draggable` sur la ligne : c'est ce qui remplace « Déplacer vers » dans le menu. Le
  // glissement d'une conversation et celui d'un dossier partagent les mêmes gestionnaires,
  // que `data-drag-conv` distingue de `data-drag`.
  return `<button class="conv-row${active}${unread}${asked ? ' asked' : ''}" data-id="${c.id}" draggable="true" data-drag-conv="${c.id}" title="${esc(c.cwd)} — ${statusLabel(c.status)}${muteTitle}${origin}${asked ? ' — attend une réponse' : ''}\nGlisser vers un dossier pour la ranger">
    <span class="st st-${c.status}${muteMark}"></span>
    ${chev}
    <span class="conv-text">
      <span class="conv-name">${esc(c.title)}</span>
      ${from}
    </span>
    ${askMark}
    ${pin}
    ${providerIcon(c.provider)}
    <span class="row-more" data-menu="${c.id}" role="button" tabindex="0" title="Actions"><svg class="icon"><use href="#i-dots"/></svg></span>
  </button>`;
}

// Profondeur d'imbrication maximale. Une chaîne de relais plus longue que ça devient
// illisible dans une sidebar, et la borne protège d'une filiation circulaire si un
// fichier d'index venait à être corrigé à la main.
const MAX_NEST = 6;

function convTree(c, kidsOf, depth) {
  const kids = depth < MAX_NEST ? kidsOf.get(c.id) || [] : [];
  const open = !collapsed.has(`conv:${c.id}`);
  const body =
    kids.length && open
      ? `<div class="conv-kids">${kids.map((k) => convTree(k, kidsOf, depth + 1)).join('')}</div>`
      : '';
  return `<div class="conv-node">${convRow(c, kids.length, depth)}${body}</div>`;
}

/** Nombre de conversations rendues dans une section, enfants imbriqués compris. */
function countTree(rows, kidsOf, depth = 0) {
  if (depth >= MAX_NEST) return rows.length;
  return rows.reduce(
    (n, c) => n + 1 + countTree(kidsOf.get(c.id) || [], kidsOf, depth + 1),
    0
  );
}

function section(key, label, iconId, rows, extra, kidsOf, title, dragId) {
  // `data-drag` n'est posé que sur les dossiers : « Épinglés » et « Récents » ne sont pas des
  // rangements qu'on déplace, ils encadrent le reste.
  const drag = dragId ? ` draggable="true" data-drag="${esc(dragId)}"` : '';

  // Où une conversation glissée peut atterrir. Déduit de la clé plutôt que passé en neuvième
  // paramètre : un dossier reçoit son identifiant, « Récents » la chaîne vide — c'est-à-dire
  // « aucun dossier », ce que l'entrée du même nom faisait dans le menu. « Épinglés » n'en est
  // pas un : épingler est un geste à part, pas un rangement.
  const target = key.startsWith('folder:')
    ? key.slice(7)
    : key === 'loose'
      ? ''
      : null;
  const drop = target === null ? '' : ` data-drop-folder="${esc(target)}"`;

  return `<div class="side-section${collapsed.has(key) ? ' collapsed' : ''}"${dragId ? ` data-drag-box="${esc(dragId)}"` : ''}${drop}>
    <button class="section-head" data-toggle="${esc(key)}"${drag}${title ? ` title="${esc(title)}"` : ''}>
      <span class="section-chev"></span>
      ${iconId ? `<svg class="icon"><use href="#${iconId}"/></svg>` : ''}
      <span class="section-name">${esc(label)}</span>
      <span class="section-count">${countTree(rows, kidsOf)}</span>
      ${extra || ''}
    </button>
    <div class="section-body">${
      rows.length ? rows.map((c) => convTree(c, kidsOf, 0)).join('') : '<div class="empty">Vide</div>'
    }</div>
  </div>`;
}

// Réconciliation par clé de la barre latérale.
//
// Elle était repeinte d'un `innerHTML` complet à chaque événement du WebSocket — y compris
// pour un `item` qui ne la concerne pas. Deux conséquences, dont la seconde était la vraie
// gêne : le défilement sautait, et surtout `.section-body` rejouait son animation
// d'apparition à chaque fois. D'où un glissement du bas vers le haut permanent, qui donnait
// l'impression que l'interface bugguait sans arrêt.
//
// On garde le rendu par chaînes — il n'y a pas de framework ici, et une section reste lisible
// d'un coup d'œil — mais on ne touche au DOM que pour les blocs dont le HTML a changé. Un
// bloc identique n'est pas remplacé : son animation ne rejoue pas, et le défilement reste où
// l'utilisateur l'avait laissé.
// La décision de quoi toucher est dans `reconcile.js`, à part et testée sans navigateur : c'est
// là que se cachent les erreurs (repeindre l'inchangé, mal calculer un ordre). Ici il ne reste
// qu'à exécuter des gestes déjà vérifiés.
const painted = new Map(); // clé -> { html, node }
let placedOrder = []; // clés dans l'ordre où elles sont posées à l'écran

function blockNode(html) {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  return wrap.firstElementChild;
}

/**
 * Pose une liste de blocs `{key, html}` dans `host`, en ne modifiant que le nécessaire.
 *
 * @param {Element} host conteneur dont cette fonction est le seul rédacteur
 * @param {{key: string, html: string}[]} blocks dans l'ordre voulu à l'écran
 */
function paintBlocks(host, blocks) {
  const wantedHtml = new Map(blocks.map((b) => [b.key, b.html]));
  // On repart de ce qui est réellement dans le document : un nœud retiré par ailleurs ne doit
  // pas être compté comme posé, sinon on calculerait des voisins qui n'existent plus.
  const placed = placedOrder
    .filter((key) => painted.get(key)?.node.isConnected)
    .map((key) => ({ key, html: painted.get(key).html }));

  // Les gestes arrivent dans l'ordre de la liste voulue : quand on traite un bloc, celui qui
  // doit le précéder est donc déjà à sa place, et sert d'ancre fiable.
  const put = (node, after) => {
    const ref = after === null ? null : painted.get(after)?.node;
    if (ref) ref.after(node);
    else host.prepend(node);
  };

  for (const op of planPaint(placed, blocks)) {
    if (op.op === 'keep') continue;
    const entry = painted.get(op.key);

    if (op.op === 'remove') {
      entry?.node.remove();
      painted.delete(op.key);
    } else if (op.op === 'move') {
      put(entry.node, op.after);
    } else {
      // `insert` et `replace` : dans les deux cas un nœud neuf, posé à sa place.
      const html = wantedHtml.get(op.key);
      const node = blockNode(html);
      if (op.op === 'replace') entry.node.remove();
      painted.set(op.key, { html, node });
      put(node, op.after);
    }
  }

  placedOrder = blocks.map((b) => b.key);
}

function renderFilters() {
  // On garde les fournisseurs dont il reste des conversations, même déconnectés : sinon
  // filtrer deviendrait impossible sur l'historique qu'on a justement gardé visible.
  $('#provider-filter').innerHTML = knownProviders()
    .map((p) => {
      const on = !hiddenProviders.has(p);
      const off = providerUsable(p) ? '' : ' gone';
      return `<button class="filter-chip ${on ? 'on' : 'off'}${off}" data-filter="${p}" title="${
        on ? 'Masquer' : 'Afficher'
      } ${PROVIDER_LABELS[p] || p}${off ? ' (non connecté)' : ''}">${providerIcon(p)}</button>`;
    })
    .join('');
}

function renderList() {
  renderFilters();

  const list = $('#conv-list');
  const term = state.search.toLowerCase();
  const items = state.convs.filter(
    (c) =>
      !state.hiding.has(c.id) &&
      !hiddenProviders.has(c.provider) &&
      (!term || c.title.toLowerCase().includes(term) || c.cwd.toLowerCase().includes(term))
  );

  if (state.convs.length) {
    // Filiation. Une conversation est rendue sous son parent, à trois exceptions près qui
    // la remontent à la racine : pas de parent, parent invisible (filtre ou recherche), ou
    // épinglage — épingler est un geste explicite qui doit primer sur l'imbrication.
    // Chaque conversation visible est donc rendue une fois et une seule.
    const visible = new Set(items.map((c) => c.id));
    const isRoot = (c) => c.pinned || !c.parentId || !visible.has(c.parentId);

    const kidsOf = new Map();
    for (const c of items) {
      if (isRoot(c)) continue;
      if (!kidsOf.has(c.parentId)) kidsOf.set(c.parentId, []);
      kidsOf.get(c.parentId).push(c);
    }
    const roots = items.filter(isRoot);

    // Chaque entrée est un bloc `{key, html}` et non une chaîne : c'est la clé qui permet de
    // reconnaître un bloc d'un rendu au suivant, donc de ne pas le reconstruire pour rien.
    const out = [];
    const pinned = roots.filter((c) => c.pinned);
    if (pinned.length) out.push({ key: 'pinned', html: section('pinned', 'Épinglés', 'i-pin', pinned, null, kidsOf) });

    // Deux natures de dossiers, que rien ne distinguait à l'œil. Un dossier de projet naît
    // tout seul quand on lance une conversation dans un dossier de travail, et porte le
    // `cwd` qui l'a fait naître ; un dossier créé à la main n'en a pas — c'est un rangement
    // choisi.
    //
    // Ils étaient groupés, les manuels puis les projets. Ce regroupement interdisait de
    // mettre un projet tout en haut, ce qui est justement le premier usage du glisser-déposer.
    // L'ordre est donc désormais celui que l'utilisateur a choisi, et ce qui les distingue
    // reste l'icône — dossier ou graphe — plus le chemin en infobulle, deux marques qui
    // survivent au repliage comme au défilement, contrairement à un trait de séparation.
    const folderSection = (folder) => {
      const rows = roots.filter((c) => c.folder === folder.id && !c.pinned);
      const more = `<span class="row-more" data-folder-menu="${folder.id}" role="button" tabindex="0" title="Actions du dossier"><svg class="icon"><use href="#i-dots"/></svg></span>`;
      return section(
        `folder:${folder.id}`,
        folder.name,
        folder.cwd ? 'i-git' : 'i-folder',
        rows,
        more,
        kidsOf,
        folder.cwd
          ? `Dossier de projet — ${folder.cwd}\nGlisser pour déplacer`
          : 'Dossier créé à la main\nGlisser pour déplacer',
        folder.id
      );
    };

    const folders = state.folders.filter((f) => !state.hiding.has(f.id));
    for (const folder of folders) {
      out.push({ key: `folder:${folder.id}`, html: folderSection(folder) });
    }
    const folderShown = folders.length > 0;

    const loose = roots.filter((c) => !c.folder && !c.pinned);
    if (loose.length || !folders.length) {
      // Trait de séparation entre les dossiers et les conversations qui n'en ont pas : les
      // deux se ressemblaient, et rien ne disait où finissait le rangement.
      if (folderShown) out.push({ key: 'rule:loose', html: '<div class="side-rule"></div>' });
      out.push({ key: 'loose', html: section('loose', 'Récents', null, loose, null, kidsOf) });
    }

    // « Aucun résultat » ne s'affiche que si le contenu des messages ne donne rien non
    // plus : sinon le message contredirait la liste juste en dessous.
    const deep = deepSection();
    if (!out.length && !deep) out.push({ key: 'none', html: '<div class="empty">Aucun résultat</div>' });
    if (deep) out.push({ key: 'deep', html: deep });
    paintBlocks(list, out);
    return;
  }

  paintBlocks(list, [{ key: 'empty', html: '<div class="empty">Aucune conversation</div>' }]);
}

$('#provider-filter').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-filter]');
  if (!chip) return;
  const provider = chip.dataset.filter;
  if (hiddenProviders.has(provider)) hiddenProviders.delete(provider);
  else hiddenProviders.add(provider);
  PREFS.write('hiddenProviders', [...hiddenProviders]);
  renderList();
});

function toggleCollapsed(key) {
  const opening = collapsed.has(key);
  if (opening) collapsed.delete(key);
  else collapsed.add(key);
  PREFS.write('collapsed', [...collapsed]);

  // L'en-tête portait peut-être le focus : replier change le HTML de la section, donc son nœud
  // est remplacé et le focus retomberait sur le document. Au clavier, on perdrait sa place
  // dans la liste à chaque dépliage.
  const hadFocus = document.activeElement?.dataset?.toggle === key;
  renderList();
  const section = painted.get(key)?.node;
  if (hadFocus) section?.querySelector('.section-head')?.focus();

  // L'animation d'apparition ne joue que pour un dépliage voulu — jamais au fil d'un
  // rafraîchissement. C'est la seule raison pour laquelle elle existe, et c'est de l'avoir
  // laissée en permanence sur `.section-body` que venait l'impression d'interface instable.
  if (!opening) return;
  const body = section?.querySelector('.section-body');
  if (!body) return;
  body.classList.add('opening');
  body.addEventListener('animationend', () => body.classList.remove('opening'), { once: true });
}

$('#conv-list').addEventListener('click', (e) => {
  // Les actions du dossier passent AVANT le dépliage. Ses trois points vivent à
  // l'intérieur de l'en-tête de section, qui porte `data-toggle` : chercher le dépliage
  // d'abord le trouvait toujours, et le menu était donc inatteignable — on repliait la
  // section au lieu de l'ouvrir.
  const folderMenu = e.target.closest('[data-folder-menu]');
  if (folderMenu) {
    e.stopPropagation();
    openFolderMenu(folderMenu.dataset.folderMenu, folderMenu);
    return;
  }

  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    toggleCollapsed(toggle.dataset.toggle);
    return;
  }

  // Le chevron des dérivées vit dans la ligne : replier ne doit pas ouvrir la conversation.
  const kidToggle = e.target.closest('[data-toggle-kids]');
  if (kidToggle) {
    e.stopPropagation();
    toggleCollapsed(`conv:${kidToggle.dataset.toggleKids}`);
    return;
  }

  const menu = e.target.closest('[data-menu]');
  if (menu) {
    e.stopPropagation();
    openRowMenu(menu.dataset.menu, menu);
    return;
  }

  // Résultat de recherche dans les messages : on ouvre la conversation et on saute au
  // message trouvé, sinon retrouver l'occurrence dans un fil de trois cents items serait
  // à refaire à la main.
  const hit = e.target.closest('[data-deep]');
  if (hit) {
    openConv(hit.dataset.deep, hit.dataset.deepItem || null);
    closeNav();
    return;
  }

  const row = e.target.closest('.conv-row');
  if (row) {
    openConv(row.dataset.id);
    closeNav();
  }
});

// --- Glisser-déposer des dossiers ----------------------------------------
//
// Réordonner ne repeint rien : la réconciliation traduit un changement d'ordre en déplacements
// de nœuds — `planPaint` le garantit et c'est testé. Le contenu des dossiers ne clignote donc
// pas pendant qu'on glisse, ce qui est la moitié de la raison d'avoir fait ce travail d'abord.

let dragFolder = null;
/** Conversation en cours de glissement. Exclusif de `dragFolder` : un geste, une nature. */
let dragConv = null;

function clearDropMarks() {
  for (const el of document.querySelectorAll('.drop-before, .drop-after, .drop-into')) {
    el.classList.remove('drop-before', 'drop-after', 'drop-into');
  }
}

function finishDrag() {
  dragFolder = null;
  dragConv = null;
  clearDropMarks();
  for (const el of document.querySelectorAll('.dragging')) {
    el.classList.remove('dragging');
  }
}

/**
 * La section survolée quand on glisse une **conversation** — celle où elle atterrirait.
 *
 * Rend `null` quand le dépôt ne changerait rien : sur sa propre section, on ne veut ni le
 * halo qui promet un déplacement, ni l'appel réseau qui n'a rien à dire.
 */
function convDropTarget(e) {
  const box = e.target.closest?.('[data-drop-folder]');
  if (!box) return null;
  const conv = state.convs.find((c) => c.id === dragConv);
  const to = box.dataset.dropFolder || null;
  if (!conv || (conv.folder || null) === to) return null;
  return { box, to };
}

/** Le dossier survolé, et de quel côté on déposerait — ou null si le geste n'a pas de cible. */
function dropTarget(e) {
  const box = e.target.closest?.('[data-drag-box]');
  if (!box || box.dataset.dragBox === dragFolder) return null;
  const rect = box.getBoundingClientRect();
  return { box, id: box.dataset.dragBox, after: e.clientY > rect.top + rect.height / 2 };
}

$('#conv-list').addEventListener('dragstart', (e) => {
  // La conversation d'abord : sa ligne vit **dans** la section du dossier, donc chercher le
  // dossier en premier attraperait les deux et on ne déplacerait jamais une conversation.
  const row = e.target.closest?.('[data-drag-conv]');
  if (row) {
    dragConv = row.dataset.dragConv;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragConv);
    row.classList.add('dragging');
    return;
  }
  const handle = e.target.closest?.('[data-drag]');
  if (!handle) return;
  dragFolder = handle.dataset.drag;
  e.dataTransfer.effectAllowed = 'move';
  // Firefox n'entame aucun glissement sans données attachées.
  e.dataTransfer.setData('text/plain', dragFolder);
  handle.closest('[data-drag-box]')?.classList.add('dragging');
});

$('#conv-list').addEventListener('dragover', (e) => {
  if (dragConv) {
    const target = convDropTarget(e);
    if (!target) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    // Un halo sur la section entière, et non un trait avant ou après : on dépose **dans** un
    // dossier, on ne choisit pas une position — l'ordre des conversations ne se règle pas ici.
    target.box.classList.add('drop-into');
    return;
  }
  if (!dragFolder) return;
  const target = dropTarget(e);
  if (!target) return;
  // Sans ce preventDefault, le navigateur refuse le dépôt : c'est lui qui autorise la zone.
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropMarks();
  target.box.classList.add(target.after ? 'drop-after' : 'drop-before');
});

$('#conv-list').addEventListener('dragleave', (e) => {
  // Seulement en quittant la liste : entre deux dossiers, l'événement part aussi et effacerait
  // le repère juste avant qu'on lise où on en est.
  if (!e.relatedTarget || !$('#conv-list').contains(e.relatedTarget)) clearDropMarks();
});

$('#conv-list').addEventListener('drop', async (e) => {
  if (dragConv) {
    const target = convDropTarget(e);
    if (!target) return;
    e.preventDefault();
    const id = dragConv;
    const conv = state.convs.find((c) => c.id === id);
    // Appliqué localement d'abord, comme pour l'ordre des dossiers : le rangement doit suivre
    // le geste, pas l'aller-retour réseau.
    const before = conv.folder || null;
    conv.folder = target.to;
    finishDrag();
    renderList();

    // Une conversation imbriquée est rendue sous son parent, dans la section du parent, quel
    // que soit son propre dossier. Le déplacement est donc réel mais invisible tant qu'elle y
    // reste : le dire vaut mieux que de laisser croire que le geste a échoué.
    const nested = conv.parentId && state.convs.some((c) => c.id === conv.parentId);
    const where = target.to
      ? (state.folders.find((f) => f.id === target.to) || {}).name
      : 'Récents';
    if (nested) toast(`Rangée dans « ${where} » — elle reste affichée sous son parent`);

    try {
      await api('PATCH', `/api/conversations/${id}`, { folder: target.to });
    } catch (err) {
      conv.folder = before;
      renderList();
      toastError(err.message);
    }
    return;
  }

  if (!dragFolder) return;
  const target = dropTarget(e);
  if (!target) return;
  e.preventDefault();

  const moved = dragFolder;
  const ids = state.folders.map((f) => f.id).filter((id) => id !== moved);
  const at = ids.indexOf(target.id);
  ids.splice(target.after ? at + 1 : at, 0, moved);

  // Appliqué localement d'abord : l'ordre doit suivre le geste, pas l'aller-retour réseau.
  const byId = new Map(state.folders.map((f) => [f.id, f]));
  state.folders = ids.map((id) => byId.get(id));
  finishDrag();
  renderList();

  try {
    await api('PATCH', '/api/folders/order', { ids });
  } catch {
    // Le serveur a refusé : on reprend son ordre plutôt que de garder deux vérités, dont une
    // qui disparaîtrait au prochain rechargement sans qu'on comprenne pourquoi.
    refreshList().catch(() => {});
  }
});

$('#conv-list').addEventListener('dragend', finishDrag);

// --- Second volet ---------------------------------------------------------
//
// Deux conversations ouvertes en même temps. Le volet de droite est un iframe de cette même
// page en mode « solo » — le pourquoi de ce choix est dans index.html, près du balisage.
//
// Une conséquence qui vaut d'être dite : ce volet a sa propre connexion WebSocket et son
// propre état. Un turn qui tourne à droite ne perturbe rien à gauche, et inversement. C'est
// exactement ce qu'on attend de deux volets, et ç'aurait été le point dur à obtenir avec un
// second pane partageant l'état de celui-ci.

/** Conversation à afficher seule, quand la page est chargée dans l'iframe du second volet. */
const SOLO = new URLSearchParams(location.search).get('solo');

const PANE_MIN = 300;

/** Fixe la largeur du volet, bornée, et la retient pour la prochaine session. */
function setPaneWidth(px) {
  const clamped = Math.round(Math.min(Math.max(px, PANE_MIN), window.innerWidth * 0.75));
  document.documentElement.style.setProperty('--pane-b-width', `${clamped}px`);
  PREFS.write('paneWidth', clamped);
}

function openPaneB(convId) {
  if (SOLO) return; // pas de volet dans le volet
  const conv = state.convs.find((c) => c.id === convId);
  $('#pane-b-title').textContent = conv ? conv.title : 'Second volet';
  const wanted = `/?solo=${encodeURIComponent(convId)}`;
  // Ne pas réassigner la même source : ça rechargerait l'iframe et perdrait son défilement.
  if (!$('#pane-b-frame').src.endsWith(wanted)) $('#pane-b-frame').src = wanted;
  $('#pane-b').classList.remove('hidden');
  $('#pane-grip').classList.remove('hidden');
  PREFS.write('paneB', convId);
}

function closePaneB() {
  $('#pane-b').classList.add('hidden');
  $('#pane-grip').classList.add('hidden');
  // On vide la source : sinon l'iframe garde sa connexion WebSocket ouverte et continuerait
  // de suivre un agent que plus personne ne regarde.
  $('#pane-b-frame').src = 'about:blank';
  PREFS.write('paneB', null);
}

if (!SOLO) {
  $('#btn-pane-close').addEventListener('click', closePaneB);

  $('#pane-grip').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = $('#pane-b').getBoundingClientRect().width;
    document.body.classList.add('resizing');
    $('#pane-grip').classList.add('dragging');

    // La poignée est à gauche du volet : tirer vers la gauche l'élargit, d'où la soustraction.
    const move = (ev) => setPaneWidth(startWidth - (ev.clientX - startX));
    const done = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', done);
      document.body.classList.remove('resizing');
      $('#pane-grip').classList.remove('dragging');
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', done);
  });
}

// Clic droit sur une ligne : même menu, c'est le réflexe courant.
$('#conv-list').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.conv-row');
  if (!row) return;
  e.preventDefault();
  openRowMenu(row.dataset.id, row);
});

// --- Menu contextuel de la sidebar ---------------------------------------

/**
 * @param anchor l'élément sous lequel le menu se pose
 * @param {{x: number, y: number}} [at] un point précis — le curseur d'un clic droit. Sur une
 *   ligne large de toute la sidebar, se caler sur son bord gauche ferait apparaître le menu
 *   loin d'où on a cliqué ; c'est sous le pointeur qu'on le cherche des yeux.
 */
function placeMenu(anchor, at) {
  const menu = $('#row-menu');
  menu.classList.remove('hidden');
  const rect = at
    ? { left: at.x, top: at.y, bottom: at.y }
    : anchor.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  const left = Math.min(rect.left, window.innerWidth - box.width - 10);
  const top =
    rect.bottom + box.height > window.innerHeight ? rect.top - box.height - 4 : rect.bottom + 4;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function closeRowMenu() {
  $('#row-menu').classList.add('hidden');
  $('#row-menu').innerHTML = '';
}

function openRowMenu(id, anchor, at) {
  const conv = state.convs.find((c) => c.id === id);
  if (!conv) return;

  // « Déplacer vers » a disparu d'ici : une entrée par dossier faisait défiler le menu dès
  // quatre dossiers, et le geste naturel pour ranger était juste à côté sans être offert.
  // Déplacer se fait maintenant en glissant la ligne sur un dossier — voir plus bas.
  $('#row-menu').innerHTML = [
    `<button data-pin="${id}"><svg class="icon"><use href="#i-pin"/></svg>${
      conv.pinned ? 'Désépingler' : 'Épingler'
    }</button>`,
    `<button data-rename-conv="${id}"><svg class="icon"><use href="#i-pencil"/></svg>Renommer</button>`,
    // Dans le volet de droite, la page est déjà en mode solo : proposer d'ouvrir un volet
    // dedans donnerait un volet dans un volet, sans intérêt et sans place.
    ...(SOLO
      ? []
      : [
          `<button data-pane-b="${id}"><svg class="icon"><use href="#i-grip"/></svg>${
            PREFS.read('paneB', null) === id ? 'Déjà à droite' : 'Ouvrir à droite'
          }</button>`,
        ]),
    ...newConvItems('new-child', id),
    '<div class="row-menu-sep"></div>',
    `<button data-delete-conv="${id}" class="danger-item"><svg class="icon"><use href="#i-trash"/></svg>Supprimer</button>`,
  ].join('');
  placeMenu(anchor, at);
}

// --- Démarrer une conversation depuis la sidebar ---------------------------
//
// Deux raccourcis qui court-circuitent l'écran « Nouveau », pour deux frictions différentes.
//
// **Depuis un dossier** : le formulaire oblige à retrouver le projet dans une liste qui
// grandit, alors qu'on vient précisément de cliquer dessus.
//
// **Depuis une conversation** : créer une dérivée passait par le relais, qui exige une
// consigne et, en croisé, un turn du parent pour écrire sa note de passation. Quand la
// session du parent est cassée — un CLI qui plante en plein turn — ce turn n'aboutit plus, et
// il devenait impossible de repartir de l'affaire en cours. L'enfant créé ici ne transmet
// **aucun contexte** et ne demande rien au parent : il hérite du dossier et du projet, s'imbrique
// sous lui dans la sidebar, et s'ouvre vide. C'est la sortie de secours du relais, pas son
// remplaçant — quand le parent va bien, le relais reste meilleur puisqu'il transporte le fil.
//
// Le fournisseur est choisi dans le menu plutôt qu'hérité, et c'est le point qui compte pour le
// cas de secours : quand un agent vient de planter, on veut souvent repartir avec un autre.
// C'est aussi la grammaire déjà en place dans ce menu, qui liste les dossiers un par un pour
// le déplacement.

/** Les entrées « Nouvelle conversation », une par fournisseur utilisable. */
function newConvItems(attr, value) {
  const usable = usableProviders();
  if (!usable.length) return [];
  return [
    '<div class="row-menu-sep"></div>',
    `<div class="row-menu-label">Nouvelle conversation${attr === 'new-child' ? ' enfant' : ''}</div>`,
    ...usable.map(
      (p) => `<button data-${attr}="${esc(value)}" data-new-provider="${esc(p)}">${providerIcon(
        p
      )}${esc(p)}</button>`
    ),
  ];
}

/**
 * Crée une conversation et l'ouvre. `spec` part tel quel au serveur — c'est lui qui décide du
 * rangement, du dossier bac à sable quand il n'y a pas de projet, et du reste.
 */
async function quickConv(spec) {
  closeRowMenu();
  try {
    const data = await api('POST', '/api/conversations', spec);
    await refreshList();
    await openConv(data.conversation.id);
    closeNav();
  } catch (err) {
    toastError(err.message);
  }
}

function newConvInFolder(folderId, provider) {
  const folder = state.folders.find((f) => f.id === folderId);
  if (!folder) return;
  quickConv({
    provider,
    // Un dossier créé à la main n'a pas de `cwd` : la conversation part alors sans projet, dans
    // son bac à sable, et c'est `folder` qui la range là où on a cliqué.
    cwd: folder.cwd || '',
    folder: folder.id,
  });
}

function newChildConv(convId, provider) {
  const parent = state.convs.find((c) => c.id === convId);
  if (!parent) return;
  quickConv({
    provider,
    // Le projet, pas le dossier de travail : depuis une conversation isolée, l'enfant doit
    // partir du dépôt et non du worktree du parent — même raison que pour un ticket envoyé
    // dans une nouvelle conversation.
    cwd: (parent.worktree && parent.worktree.repo) || parent.cwd || '',
    parentId: parent.id,
    // Le modèle et l'effort ne suivent que si l'enfant reste chez le même fournisseur : un
    // identifiant de modèle de Claude n'existe pas chez Codex.
    model: provider === parent.provider ? parent.model || null : null,
    effort: provider === parent.provider ? parent.effort || null : null,
  });
}

function openFolderMenu(id, anchor, at) {
  const folder = state.folders.find((f) => f.id === id);
  if (!folder) return;
  $('#row-menu').innerHTML = [
    // Les règles sont rangées par chemin de dépôt, pas par dossier de sidebar : un dossier
    // créé à la main n'en désigne aucun, l'entrée n'aurait rien à ouvrir.
    folder.cwd
      ? `<button data-rules-folder="${id}"><svg class="icon"><use href="#i-shield"/></svg>Règles du projet</button>`
      : '',
    `<button data-secrets-folder="${id}"><svg class="icon"><use href="#i-key"/></svg>Secrets du projet</button>`,
    `<button data-rename-folder="${id}"><svg class="icon"><use href="#i-pencil"/></svg>Renommer le dossier</button>`,
    ...newConvItems('new-in-folder', id),
    '<div class="row-menu-sep"></div>',
    `<button data-delete-folder="${id}" class="danger-item"><svg class="icon"><use href="#i-trash"/></svg>Supprimer le dossier</button>`,
    '<div class="row-menu-label">Les conversations qu\'il contient ne sont pas supprimées. Ses secrets, si.</div>',
  ].join('');
  placeMenu(anchor, at);
}

// --- Règles d'un projet ---------------------------------------------------
//
// Rangées par chemin de dépôt, comme le bloc-notes et la mémoire : une règle « git push »
// appartient au dépôt, pas au dossier de la sidebar ni à la branche isolée du moment.

let rulesProject = null;
let editingRuleId = null;

function renderRules(list) {
  const el = $('#rules-list');
  if (!list.length) {
    el.innerHTML = `<div class="empty">Aucune règle. La première est souvent
      « git push ».</div>`;
    return;
  }
  el.innerHTML = list
    .map(
      (r) => `<div class="rule-row${r.enabled === false ? ' off' : ''}" data-rule="${esc(r.id)}">
        <div class="rule-top">
          <code class="rule-name">${esc(r.name)}</code>
          ${r.always ? '<span class="rule-tag">toujours</span>' : ''}
          ${r.enabled === false ? '<span class="rule-tag off">désactivée</span>' : ''}
          <button class="ghost" data-rule-toggle="${esc(r.id)}" title="${r.enabled === false ? 'Réactiver' : 'Désactiver sans supprimer'}">
            <svg class="icon"><use href="#${r.enabled === false ? 'i-play' : 'i-pause'}"/></svg>
          </button>
          <button class="ghost" data-rule-edit="${esc(r.id)}" title="Modifier">
            <svg class="icon"><use href="#i-pencil"/></svg>
          </button>
          <button class="ghost danger-act" data-rule-del="${esc(r.id)}" title="Supprimer">
            <svg class="icon"><use href="#i-trash"/></svg>
          </button>
        </div>
        ${r.when ? `<div class="rule-when">${esc(r.when)}</div>` : ''}
        <div class="rule-body">${esc(r.body)}</div>
      </div>`
    )
    .join('');
}

function resetRuleForm() {
  editingRuleId = null;
  $('#rule-name').value = '';
  $('#rule-when').value = '';
  $('#rule-body').value = '';
  $('#rule-always').checked = false;
  $('#rules-error').textContent = '';
  $('#btn-rule-save').textContent = 'Ajouter la règle';
  $('#btn-rule-cancel').classList.add('hidden');
}

async function loadRules() {
  const data = await api('GET', `/api/rules?project=${encodeURIComponent(rulesProject)}`);
  state.rules = data.rules || [];
  renderRules(state.rules);
}

async function openRules(folderId) {
  const folder = state.folders.find((f) => f.id === folderId);
  if (!folder || !folder.cwd) return;
  rulesProject = folder.cwd;
  $('#rules-project').textContent = folder.name;
  resetRuleForm();
  $('#rules-list').innerHTML = '<div class="empty">Chargement…</div>';
  $('#rules-modal').classList.remove('hidden');
  try {
    await loadRules();
  } catch (err) {
    $('#rules-error').textContent = err.message;
  }
}

function closeRules() {
  $('#rules-modal').classList.add('hidden');
  rulesProject = null;
  resetRuleForm();
}

$('#rules-close').addEventListener('click', closeRules);
$('#rules-modal').addEventListener('click', (e) => {
  if (e.target.id === 'rules-modal') closeRules();
});
$('#btn-rule-cancel').addEventListener('click', resetRuleForm);

$('#btn-rule-save').addEventListener('click', async () => {
  const err = $('#rules-error');
  err.textContent = '';
  const body = {
    project: rulesProject,
    name: $('#rule-name').value.trim(),
    when: $('#rule-when').value.trim(),
    body: $('#rule-body').value.trim(),
    always: $('#rule-always').checked,
  };
  if (!body.name || !body.body) {
    return void (err.textContent = 'Il faut un nom et des instructions.');
  }
  $('#btn-rule-save').disabled = true;
  try {
    // Modifier passe par `PATCH` sur l'identifiant : le nom peut justement être ce qui change.
    if (editingRuleId) await api('PATCH', `/api/rules/${editingRuleId}`, body);
    else await api('POST', '/api/rules', body);
    resetRuleForm();
    await loadRules();
  } catch (e2) {
    err.textContent = e2.message;
  } finally {
    $('#btn-rule-save').disabled = false;
  }
});

$('#rules-list').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-rule-edit]');
  const toggle = e.target.closest('[data-rule-toggle]');
  const del = e.target.closest('[data-rule-del]');
  if (!edit && !toggle && !del) return;

  try {
    if (edit) {
      const rule = state.rules.find((r) => r.id === edit.dataset.ruleEdit);
      editingRuleId = rule.id;
      $('#rule-name').value = rule.name;
      $('#rule-when').value = rule.when || '';
      $('#rule-body').value = rule.body;
      $('#rule-always').checked = Boolean(rule.always);
      $('#btn-rule-save').textContent = 'Enregistrer';
      $('#btn-rule-cancel').classList.remove('hidden');
      $('#rule-name').focus();
      return;
    }
    if (toggle) {
      const rule = state.rules.find((r) => r.id === toggle.dataset.ruleToggle);
      await api('PATCH', `/api/rules/${rule.id}`, { enabled: rule.enabled === false });
    }
    if (del) {
      const rule = state.rules.find((r) => r.id === del.dataset.ruleDel);
      const sure = await askConfirm({
        title: `Supprimer « ${rule.name} » ?`,
        body: "Les agents de ce projet cesseront de la voir dès le prochain turn.",
        ok: 'Supprimer',
        danger: true,
      });
      if (!sure) return;
      await api('DELETE', `/api/rules/${rule.id}`);
      // La règle en cours de modification vient de disparaître : le formulaire n'a plus de
      // cible, et « Enregistrer » ressusciterait une règle supprimée.
      if (editingRuleId === rule.id) resetRuleForm();
    }
    await loadRules();
  } catch (err) {
    $('#rules-error').textContent = err.message;
  }
});

// --- Secrets d'un projet --------------------------------------------------
//
// L'app ne connaît jamais les valeurs : le serveur ne renvoie que les noms. Ce qui est
// affiché ici est donc tout ce qu'on peut savoir sans les faire circuler.

let secretsFolder = null;

function renderSecrets(list) {
  const el = $('#secrets-list');
  if (!list.length) {
    el.innerHTML = '<div class="empty">Aucun secret pour ce projet.</div>';
    return;
  }
  el.innerHTML = list
    .map(
      (s) => `<div class="secret-row">
        <code class="secret-name">$${esc(s.name)}</code>
        <span class="secret-meta">${s.length} caractères${
        s.updatedAt ? ` · ${esc(whenLabel(s.updatedAt))}` : ''
      }</span>
        <button class="ghost" data-secret-del="${esc(s.name)}" title="Supprimer cette clé">
          <svg class="icon"><use href="#i-trash"/></svg>
        </button>
      </div>`
    )
    .join('');
}

async function openSecrets(folderId) {
  const folder = state.folders.find((f) => f.id === folderId);
  if (!folder) return;
  secretsFolder = folderId;
  $('#secrets-folder').textContent = folder.name;
  $('#secrets-error').textContent = '';
  $('#secret-name').value = '';
  $('#secret-value').value = '';
  $('#secret-env').value = '';
  $('#secrets-report').classList.add('hidden');
  $('#secrets-list').innerHTML = '<div class="empty">Chargement…</div>';
  $('#secrets-modal').classList.remove('hidden');
  try {
    renderSecrets((await api('GET', `/api/folders/${folderId}/secrets`)).secrets);
  } catch (err) {
    $('#secrets-error').textContent = err.message;
  }
}

function closeSecrets() {
  $('#secrets-modal').classList.add('hidden');
  // Rien de saisi ne reste dans une modale qu'on rouvrira plus tard : ce sont des valeurs
  // en clair, et le champ d'import contient un fichier de secrets entier.
  $('#secret-value').value = '';
  $('#secret-env').value = '';
  secretsFolder = null;
}

$('#secrets-close').addEventListener('click', closeSecrets);
$('#secrets-modal').addEventListener('click', (e) => {
  if (e.target.id === 'secrets-modal') closeSecrets();
});

$('#btn-secret-add').addEventListener('click', async () => {
  const name = $('#secret-name').value.trim();
  const value = $('#secret-value').value;
  const err = $('#secrets-error');
  err.textContent = '';
  if (!name || !value) return void (err.textContent = 'Il faut un nom et une valeur.');
  try {
    const data = await api('PUT', `/api/folders/${secretsFolder}/secrets/${encodeURIComponent(name)}`, {
      value,
    });
    renderSecrets(data.secrets);
    $('#secret-name').value = '';
    $('#secret-value').value = '';
  } catch (e2) {
    err.textContent = e2.message;
  }
});

$('#secret-value').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btn-secret-add').click();
});

/**
 * Compte rendu d'un import. Ce qui est refusé est dit, avec sa raison : une clé disparue
 * en silence, c'est un agent qui échouera plus tard sans qu'on sache de quoi.
 */
function renderImportReport(r) {
  const el = $('#secrets-report');
  const lines = [];
  const n = r.saved.length + r.replaced.length;
  lines.push(
    `<strong>${n} clé${n > 1 ? 's' : ''} enregistrée${n > 1 ? 's' : ''}</strong>` +
      (r.replaced.length ? ` — dont ${r.replaced.length} remplacée${r.replaced.length > 1 ? 's' : ''}` : '')
  );
  for (const bad of r.rejected) {
    lines.push(`<span class="ko">✕ ${esc(bad.name)} — ${esc(bad.reason)}</span>`);
  }
  for (const bad of r.skipped) {
    lines.push(`<span class="ko">✕ ligne ignorée : ${esc(bad.line)} — ${esc(bad.reason)}</span>`);
  }
  el.innerHTML = lines.join('<br>');
  el.classList.remove('hidden');
}

$('#btn-secret-import').addEventListener('click', async () => {
  const text = $('#secret-env').value;
  const err = $('#secrets-error');
  err.textContent = '';
  if (!text.trim()) return void (err.textContent = 'Colle le contenu du fichier .env.');
  try {
    const data = await api('POST', `/api/folders/${secretsFolder}/secrets/import`, { text });
    renderSecrets(data.secrets);
    renderImportReport(data);
    // Le contenu collé ne reste pas dans le champ : c'est le fichier de secrets en clair.
    $('#secret-env').value = '';
  } catch (e2) {
    err.textContent = e2.message;
  }
});

$('#secrets-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-secret-del]');
  if (!del) return;
  const name = del.dataset.secretDel;
  const folder = secretsFolder;
  undoToast({
    message: `Clé $${name} supprimée`,
    hide: del.closest('.secret-row'),
    run: async () => {
      try {
        const data = await api(
          'DELETE',
          `/api/folders/${folder}/secrets/${encodeURIComponent(name)}`
        );
        // Le panneau a pu changer de projet entre-temps : ne réafficher que s'il montre
        // encore celui d'où la clé partait.
        if (secretsFolder === folder) renderSecrets(data.secrets);
      } catch (err) {
        $('#secrets-error').textContent = err.message;
        throw err;
      }
    },
  });
});

$('#row-menu').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const d = btn.dataset;
  closeRowMenu();

  // Le menu sert aussi au bouton « joindre » du composeur.
  if (d.attach === 'local') return $('#file-input').click();
  if (d.attach === 'gallery') return openGalleryPicker();

  // Purement local : rien à demander au serveur pour afficher une conversation à droite.
  if (d.paneB) return openPaneB(d.paneB);

  // Ces deux-là gèrent leur propre rafraîchissement et leur propre ouverture : elles sortent
  // avant le `refreshList` de fin, qui repeindrait la liste une seconde fois pour rien.
  if (d.newInFolder) return void newConvInFolder(d.newInFolder, d.newProvider);
  if (d.newChild) return void newChildConv(d.newChild, d.newProvider);

  try {
    if (d.pin) {
      const conv = state.convs.find((c) => c.id === d.pin);
      await api('PATCH', `/api/conversations/${d.pin}`, { pinned: !conv.pinned });
    } else if (d.renameConv) {
      const conv = state.convs.find((c) => c.id === d.renameConv);
      const title = await askInput({ title: 'Renommer', label: 'Titre', value: conv.title });
      if (!title || !title.trim()) return;
      await api('PATCH', `/api/conversations/${d.renameConv}`, { title });
      if (state.currentId === d.renameConv) {
        state.current.title = title;
        renderHead();
      }
    } else if (d.deleteConv) {
      return void deleteConvWithUndo(d.deleteConv);
    } else if (d.rulesFolder) {
      return void openRules(d.rulesFolder);
    } else if (d.secretsFolder) {
      // Ouvre une modale et n'a rien à rafraîchir dans la liste : on sort tout de suite.
      return void openSecrets(d.secretsFolder);
    } else if (d.renameFolder) {
      const folder = state.folders.find((f) => f.id === d.renameFolder);
      const name = await askInput({ title: 'Renommer le dossier', label: 'Nom', value: folder.name });
      if (!name || !name.trim()) return;
      await api('PATCH', `/api/folders/${d.renameFolder}`, { name });
    } else if (d.deleteFolder) {
      const folder = state.folders.find((f) => f.id === d.deleteFolder);
      state.hiding.add(folder.id);
      renderList();
      return void undoToast({
        message: `Dossier « ${folder.name} » supprimé — les conversations sont conservées`,
        run: async () => {
          try {
            await api('DELETE', `/api/folders/${folder.id}`);
          } finally {
            state.hiding.delete(folder.id);
          }
          await refreshList();
        },
        undone: () => {
          state.hiding.delete(folder.id);
          renderList();
        },
      });
    }
    await refreshList();
  } catch (err) {
    toastError(err.message);
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#row-menu') && !e.target.closest('[data-menu], [data-folder-menu]')) {
    closeRowMenu();
  }
});

/**
 * Clic droit sur une ligne : le même menu que ses trois points.
 *
 * Le menu natif du navigateur ne propose rien d'utile sur un `<button>` de la sidebar, et
 * viser une cible de 20 px de large est le geste que ce raccourci remplace. Le menu du
 * navigateur reste accessible partout ailleurs — c'est pourquoi la capture est limitée aux
 * lignes, et non posée sur la liste entière.
 *
 * L'en-tête de section n'ouvre le menu que si elle porte `data-drag`, qui n'est posé que sur
 * les dossiers : « Épinglés » et « Récents » ne sont pas des rangements, ils n'ont pas d'actions.
 */
$('#conv-list').addEventListener('contextmenu', (e) => {
  const at = { x: e.clientX, y: e.clientY };
  const head = e.target.closest('.section-head[data-drag]');
  if (head) {
    e.preventDefault();
    return openFolderMenu(head.dataset.drag, head, at);
  }
  const row = e.target.closest('.conv-row[data-id]');
  if (!row) return;
  e.preventDefault();
  openRowMenu(row.dataset.id, row, at);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeRowMenu();
});

/**
 * Supprimer une conversation ne se confirme pas : ça se défait. Si c'est celle qu'on
 * lisait, on quitte l'écran tout de suite — et on y revient si l'utilisateur annule,
 * sans quoi l'annulation laisserait un fil ouvert sans savoir s'il existe encore.
 */
function deleteConvWithUndo(id) {
  const conv = state.convs.find((c) => c.id === id);
  const wasOpen = state.currentId === id;

  state.hiding.add(id);
  if (wasOpen) showNew();
  else renderList();

  undoToast({
    message: `« ${conv ? conv.title : 'Conversation'} » supprimée`,
    run: async () => {
      try {
        await api('DELETE', `/api/conversations/${id}`);
      } finally {
        // Le filtre doit tomber dans tous les cas : sur succès la conversation n'existe
        // plus, sur échec elle doit redevenir visible plutôt que de disparaître pour de
        // faux jusqu'au prochain rechargement.
        state.hiding.delete(id);
      }
      await refreshList();
    },
    undone: () => {
      state.hiding.delete(id);
      if (wasOpen) openConv(id);
      else renderList();
    },
  });
}

$('#btn-new-folder').addEventListener('click', async () => {
  const name = await askInput({ title: 'Nouveau dossier', label: 'Nom', ok: 'Créer' });
  if (!name || !name.trim()) return;
  try {
    await api('POST', '/api/folders', { name });
    await refreshList();
  } catch (err) {
    toastError(err.message);
  }
});

$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderList();
  runDeepSearch();
});

// --- Recherche dans les fils ----------------------------------------------
//
// La saisie filtre immédiatement les titres et les dossiers, ce qui est local et gratuit.
// La recherche dans le contenu des messages, elle, passe par le serveur : elle est donc
// différée, et une réponse arrivée après une frappe plus récente est jetée — sans quoi
// l'affichage clignoterait entre deux états au gré des latences.

let deepTimer = null;
let deepSeq = 0;

function runDeepSearch() {
  clearTimeout(deepTimer);
  const term = state.search.trim();
  if (term.length < 2) {
    state.deep = null;
    renderList();
    return;
  }
  deepTimer = setTimeout(async () => {
    const seq = (deepSeq += 1);
    try {
      const data = await api('GET', `/api/search?q=${encodeURIComponent(term)}`);
      if (seq !== deepSeq) return; // réponse périmée : une frappe plus récente est partie
      state.deep = data;
    } catch {
      state.deep = null; // la recherche locale continue de marcher, elle
    }
    renderList();
  }, 250);
}

/** Section « Dans les messages », sous les conversations filtrées par titre. */
function deepSection() {
  const deep = state.deep;
  if (!deep || deep.term !== state.search.trim().toLowerCase()) return '';
  if (!deep.results.length) {
    return '<div class="deep-empty">Rien dans le contenu des messages</div>';
  }

  const hidden = (convId) => {
    const conv = state.convs.find((c) => c.id === convId);
    return conv && hiddenProviders.has(conv.provider);
  };

  const rows = deep.results
    .filter((r) => !hidden(r.convId))
    .map((r) => {
      const hits = r.matches
        .map(
          (m) =>
            `<div class="deep-hit" data-deep="${esc(r.convId)}" data-deep-item="${esc(
              m.itemId || ''
            )}">${esc(m.snippet)}</div>`
        )
        .join('');
      return `<div class="deep-conv"><div class="deep-title" data-deep="${esc(
        r.convId
      )}">${esc(r.title)}<span class="deep-count">${r.count}${
        r.count >= 5 ? '+' : ''
      }</span></div>${hits}</div>`;
    })
    .join('');

  if (!rows) return '';
  return `<div class="deep"><div class="deep-head">Dans les messages</div>${rows}</div>`;
}

/** Amène un message à l'écran et le signale brièvement. */
function focusItem(itemId) {
  const node = document.querySelector(`[data-item="${itemId}"]`);
  if (!node) return;
  if ('open' in node) node.open = true;
  node.scrollIntoView({ block: 'center' });
  node.classList.add('found');
  setTimeout(() => node.classList.remove('found'), 2500);
}

// --- Rendu des messages ---------------------------------------------------

function summarizeInput(item) {
  const input = item.input || {};
  if (typeof input === 'string') return input;
  const first =
    input.command ||
    input.file_path ||
    input.path ||
    input.pattern ||
    input.query ||
    input.prompt ||
    input.files ||
    input.url ||
    input.description;
  return first ? String(first) : Object.keys(input).length ? JSON.stringify(input) : '';
}

// Un item produit par un sous-agent est décalé et signalé au survol. C'est le seul
// indice disponible : le flux ne nomme pas le sous-agent, il ne donne que l'identifiant
// de l'appel d'outil qui l'a lancé.
/**
 * Message d'utilisateur dont la première ligne appelle une skill : la commande ressort en
 * accent, comme dans un terminal. Échappé d'abord — la mise en forme ne doit pas ouvrir la
 * porte à du HTML venu du texte.
 */
function skillCall(text) {
  const safe = esc(text);
  return safe.replace(/^\/([a-z0-9][a-z0-9:-]*)/i, '<span class="skill-call">/$1</span>');
}

const nestedClass = (item) => (item.nested ? ' nested' : '');
const nestedTitle = (item) => (item.nested ? ' title="Produit par un sous-agent"' : '');

function renderItem(item) {
  switch (item.kind) {
    case 'user': {
      const images = (item.images || []).map(renderStoredAttachment).join('');
      // Le bouton n'apparaît que si l'instantané a réellement été pris.
      // Markup sur une seule ligne : le conteneur est en white-space: pre-wrap, donc
      // toute indentation à l'intérieur du bouton se verrait à l'écran.
      const cp = item.checkpoint;
      const rewind =
        cp && cp.sha
          ? `<button class="msg-rewind" data-rewind="${esc(cp.sha)}" title="Restaurer les fichiers à leur état d'avant ce message"><svg class="icon"><use href="#i-rewind"/></svg>Fichiers</button>`
          : '';
      // La demande de note de passation est longue et toujours la même : on la replie
      // pour qu'elle n'écrase pas le fil, sans rien cacher de ce qui a été envoyé.
      if (item.handoff === 'request') {
        return `<details class="msg msg-user msg-handoff" data-item="${item.id}"><summary><svg class="icon"><use href="#i-relay"/></svg>Note de passation demandée pour un relais</summary><div class="handoff-body">${esc(item.text)}</div></details>`;
      }
      // Mode objectif : trois messages que l'application a rédigés — l'ouverture, la
      // vérification, la relance. Ils ont réellement été envoyés et ont coûté un turn, donc on
      // les replie sans les cacher ; ce qui compte tient dans leur résumé.
      if (item.goal) {
        const head = {
          start: `Objectif ouvert${item.goalText ? ` — ${esc(item.goalText)}` : ''}`,
          check: 'Point sur l’objectif demandé',
          continue: 'Relance : ce qui reste à faire',
        }[item.goal];
        return `<details class="msg msg-user msg-handoff msg-goal" data-item="${item.id}"><summary><svg class="icon"><use href="#i-target"/></svg>${
          head || 'Mode objectif'
        }</summary><div class="handoff-body">${esc(item.text)}</div></details>`;
      }
      // Même traitement que la note de passation : la consigne est longue et toujours la
      // même, mais elle a bien été envoyée et a coûté un turn — on la replie, on ne la cache pas.
      if (item.report === 'request') {
        return `<details class="msg msg-user msg-handoff" data-item="${item.id}"><summary><svg class="icon"><use href="#i-clock"/></svg>Rapport de fin demandé</summary><div class="handoff-body">${esc(item.text)}</div></details>`;
      }
      return `<div class="msg msg-user" data-item="${item.id}">${rewind}${skillCall(item.text)}${
        images ? `<div class="msg-images">${images}</div>` : ''
      }</div>`;
    }

    case 'text':
      if (item.handoff === 'note') {
        return `<div class="msg msg-text msg-note" data-item="${item.id}">
          <div class="note-badge"><svg class="icon"><use href="#i-relay"/></svg>Note de passation${
            item.handoffFile ? ` · ${esc(item.handoffFile)}` : ''
          }</div>${md(item.text)}</div>`;
      }
      return `<div class="msg msg-text${nestedClass(item)}" data-item="${item.id}"${nestedTitle(
        item
      )}>${md(item.text)}</div>`;

    case 'thinking':
      return `<details class="think${nestedClass(item)}" data-item="${item.id}"${nestedTitle(
        item
      )}><summary>Réflexion</summary><div class="tool-body">${esc(item.text)}</div></details>`;

    case 'tool': {
      const body = [];
      if (item.input && Object.keys(item.input).length) {
        body.push(`<pre>${esc(
          typeof item.input === 'string' ? item.input : JSON.stringify(item.input, null, 2)
        )}</pre>`);
      }
      if (item.result != null && item.result !== '') {
        const text = String(item.result);
        const clipped = text.length > 6000 ? `${text.slice(0, 6000)}\n… (${text.length} caractères)` : text;
        body.push(`<pre>${esc(clipped)}</pre>`);
      }
      // Images renvoyées par l'outil : les captures d'un navigateur. Le bloc s'ouvre de
      // lui-même quand il y en a — une capture repliée derrière un chevron ne sert à rien,
      // c'est précisément ce qu'on voulait voir.
      const shots = (item.images || []).length
        ? `<div class="tool-shots">${item.images
            .map(
              (img) =>
                `<button data-image="${esc(img.url)}" data-name="${esc(img.name || 'capture')}" title="Agrandir">
                  <img src="${esc(img.url)}" alt="${esc(img.name || 'capture')}" decoding="async">
                </button>`
            )
            .join('')}</div>`
        : '';
      if (shots) body.push(shots);

      return `<details class="tool${item.isError ? ' err' : ''}${nestedClass(item)}${
        shots ? ' has-shots' : ''
      }" data-item="${item.id}"${nestedTitle(item)}${shots ? ' open' : ''}>
        <summary><span class="tool-name">${esc(item.tool)}</span><span class="tool-arg">${esc(
        summarizeInput(item)
      )}</span></summary>
        <div class="tool-body">${body.join('')}</div>
      </details>`;
    }

    case 'result':
      return item.isError
        ? `<div class="msg-err" data-item="${item.id}">${esc(item.text || 'Erreur')}</div>`
        : '';

    case 'notice': {
      // Un avis peut porter un instantané : c'est le cas après une restauration,
      // dont on peut alors revenir d'un clic.
      const undo =
        item.checkpoint && item.checkpoint.sha
          ? ` <button class="msg-undo" data-rewind="${esc(item.checkpoint.sha)}"><svg class="icon"><use href="#i-rewind"/></svg>${esc(item.checkpointLabel || 'Revenir')}</button>`
          : '';
      // Une leçon proposée pour la mémoire du projet. Deux boutons, et rien n'entre dans les
      // prompts avant que l'un des deux ait été cliqué : c'est cette relecture qui empêche la
      // mémoire de se remplir de banalités.
      const lesson = item.memoryId
        ? ` <button class="msg-undo" data-memory-keep="${esc(item.memoryId)}"><svg class="icon"><use href="#i-check"/></svg>Garder</button>` +
          ` <button class="msg-undo" data-memory-drop="${esc(item.memoryId)}"><svg class="icon"><use href="#i-close"/></svg>Écarter</button>`
        : '';
      return `<div class="msg-notice" data-item="${item.id}"><span>${esc(item.text)}${undo}${lesson}</span></div>`;
    }

    default:
      return '';
  }
}

function atBottom() {
  const el = $('#messages');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

function scrollDown(force) {
  const el = $('#messages');
  if (force || atBottom()) el.scrollTop = el.scrollHeight;
}

function renderMessages() {
  const el = $('#messages');
  const conv = state.current;
  el.innerHTML = conv.items.length
    ? conv.items.map(renderItem).join('')
    : '<div class="empty">Aucun message</div>';
  if (state.isRunning) showProcessing();
  scrollDown(true);
}

// État visible entre l'envoi du message et le premier delta / outil. Sans lui, un CLI
// qui met plusieurs secondes à démarrer ressemble exactement à une connexion perdue.
function showProcessing() {
  if (!state.currentId || document.querySelector('.processing')) return;
  const empty = $('#messages .empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'streaming processing';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML =
    '<span class="processing-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
    '<span>Réflexion en cours…</span>';
  const stick = atBottom();
  $('#messages').appendChild(el);
  scrollDown(stick);
}

function clearProcessing() {
  document.querySelectorAll('.processing').forEach((el) => el.remove());
}

// Bulle de streaming éphémère (les deltas ne sont jamais persistés côté serveur).
function streamEl(kind) {
  clearProcessing();
  let el = document.querySelector(`.streaming[data-kind="${kind}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = `streaming${kind === 'thinking' ? ' think-stream' : ''}`;
    el.dataset.kind = kind;
    el.dataset.raw = '';
    $('#messages').appendChild(el);
  }
  return el;
}

function clearStreams() {
  document.querySelectorAll('.streaming').forEach((el) => el.remove());
}

// --- Conversation courante -----------------------------------------------

function renderHead() {
  const c = state.current;
  $('#conv-title').textContent = c.title;
  // Sur une conversation isolée, le dossier de travail est `data/worktrees/<uuid>` : un
  // chemin qui n'apprend rien. Ce qu'on veut lire, c'est le projet et la branche.
  const wt = c.worktree;
  const bits = [
    providerIcon(c.provider),
    `<code>${esc(wt ? wt.repo : c.cwd)}</code>`,
    wt ? `<span class="branch-tag">${esc(wt.branch)}</span>` : null,
    c.model ? esc(c.model) : null,
    statusLabel(c.status),
    // Dit à côté du statut, parce que c'est le statut qu'il corrige : « travaille » et
    // « silencieux depuis 40 min » ne racontent pas la même histoire.
    silenceOf(c.id) ? `<span class="meta-mute">${esc(silenceLabel(silenceOf(c.id)))}</span>` : null,
    c.totalCostUsd ? `$${c.totalCostUsd.toFixed(4)}` : null,
  ].filter(Boolean);
  $('#conv-meta').innerHTML = bits.join(' · ');
  $('#mobile-head-meta').innerHTML = bits.join(' · ');

  renderConvModel(c);
  setEffortSelect($('#conv-effort'), c.provider, c.model || '', false);
  $('#conv-effort').value = c.effort || '';

  renderBrowserToggle();
  renderWatchToggle();
  renderGitToggle();
  renderMergeToggle();
  renderContext();
  setRunning(state.isRunning);
}

/**
 * Bouton de fusion. Présent seulement sur une conversation isolée, et son infobulle dit ce
 * que la fusion apporterait — l'état est relu à chaque ouverture parce qu'un agent a pu
 * commiter entre-temps, ou ne rien commiter du tout, ce qui est le cas fréquent.
 */
async function renderMergeToggle() {
  const c = state.current;
  const shown = Boolean(c && c.worktree);
  $('#btn-merge').classList.toggle('hidden', !shown);
  $('#mobile-action-merge').classList.toggle('hidden', !shown);
  if (!shown) return;

  const id = state.currentId;
  let title = `Fusionner ${c.worktree.branch}`;
  try {
    const data = await api('GET', `/api/conversations/${id}/worktree`);
    // La conversation a pu changer pendant la requête : on n'écrit pas sur l'en-tête
    // d'une autre.
    if (state.currentId !== id) return;
    const s = data.state || {};
    const parts = [];
    if (s.ahead) parts.push(`${s.ahead} commit(s) d'avance`);
    if (s.dirty) parts.push(`${s.dirty} fichier(s) non commité(s)`);
    if (!parts.length) parts.push('rien de nouveau');
    title = `Fusionner ${c.worktree.branch} dans ${s.target || '?'} — ${parts.join(', ')}`;
  } catch {
    /* le dépôt peut être injoignable : le bouton reste, le serveur dira pourquoi au clic */
  }
  $('#btn-merge').title = title;
}

$('#btn-merge').addEventListener('click', async () => {
  const c = state.current;
  if (!c || !c.worktree) return;
  // Une fusion n'est pas une suppression : il y a quelque chose à lire avant de décider,
  // et la différer de six secondes n'y changerait rien. La modale reste.
  const ok = await askConfirm({
    title: 'Fusionner la branche',
    body:
      `${c.worktree.branch} va être fusionnée dans le dépôt principal.\n\n` +
      ($('#btn-merge').title || ''),
    ok: 'Fusionner',
  });
  if (!ok) return;
  try {
    await api('POST', `/api/conversations/${c.id}/worktree/merge`);
    // Le compte rendu arrive dans le fil par le websocket, comme un avis ordinaire : il n'y
    // a plus que l'infobulle à remettre à jour, l'avance venant de retomber à zéro.
    renderMergeToggle();
  } catch (err) {
    toastError(err.message);
  }
});

function closeMobileHeadMenu() {
  $('#mobile-head-menu').classList.add('hidden');
  $('#btn-head-more').setAttribute('aria-expanded', 'false');
}

function closeComposeMenu() {
  $('#compose-menu').classList.add('hidden');
  $('#btn-compose-more').setAttribute('aria-expanded', 'false');
}

$('#btn-head-expand').addEventListener('click', () => {
  const expanded = $('#conv-head').classList.toggle('mobile-expanded');
  $('#btn-head-expand').setAttribute('aria-expanded', String(expanded));
  $('#btn-head-expand').title = expanded ? 'Masquer les réglages' : 'Afficher les réglages';
  closeMobileHeadMenu();
});

$('#btn-head-more').addEventListener('click', (e) => {
  e.stopPropagation();
  const opening = $('#mobile-head-menu').classList.contains('hidden');
  closeComposeMenu();
  $('#mobile-head-menu').classList.toggle('hidden', !opening);
  $('#btn-head-more').setAttribute('aria-expanded', String(opening));
});

$('#mobile-head-menu').addEventListener('click', (e) => {
  const action = e.target.closest('[data-head-action]');
  if (!action) return;
  closeMobileHeadMenu();
  const target = {
    git: '#btn-git',
    notes: '#btn-notes',
    plans: '#btn-plans',
    compact: '#btn-compact',
    'resume-light': '#btn-resume-light',
    merge: '#btn-merge',
    relay: '#btn-relay',
    delete: '#btn-delete',
  }[action.dataset.headAction];
  if (target) $(target).click();
});

/**
 * Bouton navigateur de l'en-tête. Absent tant que le fournisseur de la conversation ne
 * peut pas en recevoir un — le cacher plutôt que le griser : un bouton qu'on ne peut pas
 * activer n'apprend rien.
 */
function renderBrowserToggle() {
  const c = state.current;
  const btn = $('#btn-browser');
  const models = state.models || {};
  const browsable = (models.browsable || []).includes(c.provider);
  const always = (models.browserAlways || []).includes(c.provider);

  btn.classList.toggle('hidden', !browsable && !always);
  btn.disabled = always;

  // Inscrit globalement hors de l'app : le navigateur est là, et rien dans l'app ne peut
  // le retirer. On l'affiche allumé et inerte plutôt que sous une case menteuse.
  if (always) {
    btn.classList.add('on');
    btn.title =
      'Navigateur toujours actif pour cet agent : il est inscrit dans sa configuration ' +
      "globale, hors de l'app. Rien ici ne peut le retirer.";
    return;
  }
  if (!browsable) return;

  btn.classList.toggle('on', Boolean(c.browser));
  btn.title = c.browser
    ? "Navigateur actif : l'agent peut ouvrir des pages et prendre des captures. Cliquer pour le retirer."
    : "Donner un navigateur à l'agent (appliqué au turn suivant)";
}

// --- Graphe git du projet -------------------------------------------------
//
// Le dessin vient de `git log --graph`, calculé par git : voir `lib/git.js` pour la raison,
// et pour ce que l'état des bibliothèques web a donné à la recherche. Côté affichage il n'y
// a donc rien à placer — juste à rendre la colonne de dessin en monospace, sans y toucher.

/** Résultat de la sonde par conversation : un `rev-parse` par fil, pas un par ouverture. */
const gitProbe = new Map();

/**
 * Bouton du graphe. Caché quand le dossier de travail n'est pas versionné, comme le bouton
 * du navigateur l'est quand l'agent n'en accepte pas : un bouton qu'on ne peut pas activer
 * n'apprend rien.
 */
async function renderGitToggle() {
  const btn = $('#btn-git');
  const id = state.currentId;
  if (!id) {
    btn.classList.add('hidden');
    $('#mobile-action-git').classList.add('hidden');
    return;
  }

  if (!gitProbe.has(id)) {
    btn.classList.add('hidden');
    try {
      const data = await api('GET', `/api/conversations/${id}/git?probe=1`);
      gitProbe.set(id, Boolean(data.repo));
    } catch {
      gitProbe.set(id, false);
    }
  }

  // La sonde est asynchrone : la conversation a pu changer entre-temps, et décider pour
  // celle qu'on vient de quitter afficherait un bouton qui ne correspond à rien.
  if (state.currentId !== id) return;
  btn.classList.toggle('hidden', !gitProbe.get(id));
  $('#mobile-action-git').classList.toggle('hidden', !gitProbe.get(id));
}

/** Le panneau appartient au projet ouvert : changer de conversation doit le refermer. */
function closeGitPanel() {
  $('#git-panel').classList.add('hidden');
  $('#git-grip').classList.add('hidden');
  $('#btn-git').classList.remove('on');
}

function closeNotesPanel() {
  $('#notes-panel').classList.add('hidden');
  $('#notes-grip').classList.add('hidden');
  $('#btn-notes').classList.remove('on');
}

// Le tiroir des plans ne connaît le projet que par la conversation ouverte, et il vit dans son
// propre fichier. C'est le seul point de contact dans ce sens : une fonction plutôt que
// `state.currentId` en lecture directe, pour que `plans.js` ne dépende pas de la forme de
// l'état d'`app.js`.
window.currentConvId = () => state.currentId;

/**
 * Dépose un texte dans le composeur, sans l'envoyer.
 *
 * Exposée pour le tiroir des plans, et écrite ici parce que la convention est celle des prompts
 * enregistrés et doit rester à un seul endroit : **ajouté à la suite plutôt qu'en remplacement**,
 * un composeur déjà rempli contenant du travail. L'événement `input` n'est pas décoratif — c'est
 * lui qui fait grandir le champ et réévaluer le bouton d'envoi.
 *
 * Ne pas envoyer est le choix qui compte : on veut presque toujours ajouter une phrase — « le
 * relais a changé, mets-le à jour » — avant de lancer l'agent.
 */
window.composeInto = (text) => {
  const box = $('#prompt');
  if (!box || !text) return;
  box.value = box.value.trim() ? `${box.value.replace(/\s+$/, '')}\n\n${text}` : text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
  box.selectionStart = box.selectionEnd = box.value.length;
};

function closePlansPanel() {
  $('#plans-panel').classList.add('hidden');
  $('#plans-grip').classList.add('hidden');
  $('#btn-plans').classList.remove('on');
  // Le tiroir garde le document ouvert et son éditeur : les oublier au moment où on le ferme
  // évite qu'il se rouvre sur le plan d'un autre projet.
  if (window.plansPanel) window.plansPanel.close();
}

// Géométrie du dessin. La hauteur de ligne est la même pour le SVG et pour le texte : c'est
// elle qui aligne un nœud sur son sujet, et la désaccorder décale tout le panneau.
const GIT_ROW_H = 27;
const GIT_LANE_W = 15;
const GIT_LANES_MAX = 14; // au-delà, le dessin mangerait le texte : on laisse déborder
const GIT_COLORS = 8; // doit correspondre au nombre de --lane-N de la feuille de style

const gitX = (col) => col * GIT_LANE_W + GIT_LANE_W / 2 + 1;
const gitY = (row) => row * GIT_ROW_H + GIT_ROW_H / 2;
const gitLaneColor = (lane) => `var(--lane-${lane % GIT_COLORS})`;

/**
 * Tracé d'un trait, de l'enfant vers le parent en passant par sa lane.
 *
 * Trois colonnes peuvent être en jeu : celle d'où le trait part, celle où il descend, celle
 * où il arrive. Il quitte donc sa colonne de départ par une courbe, descend droit, puis
 * rejoint sa destination par une seconde courbe — c'est ce qui donne l'allure d'un vrai
 * client git plutôt qu'une diagonale.
 *
 * La courbure est bornée par la distance disponible : sur un trait d'une seule ligne, deux
 * courbes de pleine hauteur se chevaucheraient et produiraient une boucle.
 */
function gitEdgePath(edge, lastRow) {
  const x1 = gitX(edge.fromCol);
  const y1 = gitY(edge.fromRow);
  const xl = gitX(edge.lane);

  // Trait sans destination : le parent est hors de la fenêtre demandée, il sort par le bas.
  const dangling = edge.toRow === null;
  const y2 = dangling ? gitY(lastRow) + GIT_ROW_H : gitY(edge.toRow);
  const x2 = dangling ? xl : gitX(edge.toCol);

  const bendsIn = edge.fromCol !== edge.lane;
  const bendsOut = !dangling && edge.toCol !== edge.lane;
  if (!bendsIn && !bendsOut) return `M ${x1} ${y1} L ${x1} ${y2}`;

  const bend = Math.min(GIT_ROW_H, (y2 - y1) / (bendsIn && bendsOut ? 2 : 1));
  const parts = [`M ${x1} ${y1}`];
  let y = y1;

  if (bendsIn) {
    parts.push(`C ${x1} ${y + bend * 0.55}, ${xl} ${y + bend * 0.45}, ${xl} ${y + bend}`);
    y += bend;
  }
  if (bendsOut) {
    if (y2 - bend > y) parts.push(`L ${xl} ${y2 - bend}`);
    parts.push(`C ${xl} ${y2 - bend * 0.45}, ${x2} ${y2 - bend * 0.55}, ${x2} ${y2}`);
  } else {
    parts.push(`L ${xl} ${y2}`);
  }
  return parts.join(' ');
}

/** Le SVG des lanes : les traits d'abord, les nœuds par-dessus. */
function gitCanvas(data) {
  const lastRow = data.rows.length - 1;
  const width = Math.min(data.columns, GIT_LANES_MAX) * GIT_LANE_W + 2;
  const height = data.rows.length * GIT_ROW_H;

  const traits = data.edges
    .map(
      (e) =>
        `<path d="${gitEdgePath(e, lastRow)}" fill="none" stroke="${gitLaneColor(
          e.lane
        )}" stroke-width="1.7" stroke-linecap="round"/>`
    )
    .join('');

  const nodes = data.rows
    .map((r) => {
      const cx = gitX(r.col);
      const cy = gitY(r.row);
      const color = gitLaneColor(r.col);
      const head = r.refs.some((ref) => ref.head);
      // Une fusion est un anneau et un commit ordinaire un disque : la différence se lit d'un
      // coup d'œil, là où deux disques de tailles voisines ne se distinguent pas.
      const shape = r.merge
        ? `<circle cx="${cx}" cy="${cy}" r="4.1" fill="var(--bg-side)" stroke="${color}" stroke-width="2"/>`
        : `<circle cx="${cx}" cy="${cy}" r="3.7" fill="${color}"/>`;
      // HEAD porte un halo : c'est le seul repère qu'on cherche en ouvrant le panneau.
      const halo = head
        ? `<circle cx="${cx}" cy="${cy}" r="6.8" fill="none" stroke="${color}" stroke-width="1.4" opacity=".45"/>`
        : '';
      return halo + shape;
    })
    .join('');

  return `<svg class="git-canvas" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${traits}${nodes}</svg>`;
}

// Auteur d'une ligne : une pastille d'initiales, remplacée par la photo Gravatar quand il y en
// a une. Les initiales sont dessinées les premières et ne dépendent de rien : sans réseau, sans
// compte Gravatar, la colonne reste lisible au lieu de montrer des carrés vides.
//
// L'empreinte de l'adresse est calculée par le serveur (`lib/git.js`) : `crypto.subtle` n'existe
// qu'en contexte sécurisé, et l'app est souvent servie en HTTP clair (localhost / VPN). La
// requête d'image, elle, part du navigateur — c'est donc lui qui parle à gravatar.com, en
// n'envoyant que cette empreinte.

const GIT_AVATAR_PX = 40; // deux fois la taille affichée : les écrans denses ne floutent pas

const gravatarUrl = (hash) => `https://www.gravatar.com/avatar/${hash}?s=${GIT_AVATAR_PX}&d=404`;

/**
 * Y a-t-il une photo pour cette empreinte ? Une sonde par auteur, mémorisée — pas une par ligne,
 * sinon 80 commits du même auteur valent 80 requêtes.
 *
 * `d=404` fait répondre Gravatar en erreur plutôt qu'avec sa silhouette générique : c'est ce qui
 * permet de distinguer « pas de photo » de « photo », et de garder les initiales dans le premier
 * cas. Hors ligne, `onerror` tombe pareil — donc au bon endroit.
 */
const gravatarSeen = new Map();
function hasGravatar(hash) {
  if (!gravatarSeen.has(hash)) {
    gravatarSeen.set(
      hash,
      new Promise((resolve) => {
        const probe = new Image();
        probe.onload = () => resolve(true);
        probe.onerror = () => resolve(false);
        probe.src = gravatarUrl(hash);
      })
    );
  }
  return gravatarSeen.get(hash);
}

/** « Jane Doe » → « AM ». Le premier prénom et le dernier nom, comme partout ailleurs. */
function gitInitials(name) {
  const parts = String(name || '')
    .trim()
    .split(/[\s_.-]+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  const first = [...parts[0]][0] || '';
  const last = parts.length > 1 ? [...parts[parts.length - 1]][0] || '' : '';
  return (first + last).toUpperCase();
}

/**
 * Couleur de la pastille, tirée de l'identité et non de la ligne : le même auteur garde la même
 * teinte d'un commit à l'autre, et d'une ouverture du panneau à la suivante.
 */
function gitAuthorColor(key) {
  let h = 0;
  for (const ch of String(key || '?')) h = (h * 31 + ch.codePointAt(0)) % 1000003;
  return gitLaneColor(h);
}

/** La pastille d'un auteur. `data-avatar` sert à y poser la photo quand la sonde a répondu. */
function gitAvatar(row) {
  const initials = gitInitials(row.author);
  const color = gitAuthorColor(row.avatar || row.author);
  const attr = row.avatar ? ` data-avatar="${esc(row.avatar)}"` : '';
  return `<span class="git-av" style="--av:${color}"${attr} aria-hidden="true">${esc(initials)}</span>`;
}

/**
 * Remplace les initiales par les photos, une fois les sondes revenues.
 *
 * `isConnected` : le panneau a pu être redessiné entre-temps — poser une image sur des lignes
 * détachées du document ne casse rien, mais autant ne pas le faire.
 */
function hydrateGitAvatars(plot) {
  const cells = [...plot.querySelectorAll('.git-av[data-avatar]')];
  for (const hash of new Set(cells.map((el) => el.dataset.avatar))) {
    hasGravatar(hash).then((ok) => {
      if (!ok || !plot.isConnected) return;
      for (const el of cells) {
        if (el.dataset.avatar !== hash) continue;
        el.style.backgroundImage = `url("${gravatarUrl(hash)}")`;
        el.classList.add('is-photo');
      }
    });
  }
}

/** Une étiquette de ref, colorée selon sa nature. La branche courante porte une coche. */
function gitRefChip(ref) {
  const kind = ref.head && ref.kind !== 'tag' ? 'head' : ref.kind;
  const mark = ref.head && ref.kind !== 'tag' ? '<span class="git-ref-check">✓</span>' : '';
  return `<span class="git-ref is-${esc(kind)}" title="${esc(ref.name)}">${mark}${esc(ref.name)}</span>`;
}

function renderGit(data) {
  const body = $('#git-body');

  if (!data.repo) {
    $('#git-branch').textContent = '';
    $('#git-state').textContent = '';
    body.innerHTML = "<div class=\"empty\">Ce dossier de travail n'est pas un dépôt git.</div>";
    return;
  }

  $('#git-branch').textContent = data.branch || '(HEAD détaché)';

  const bits = [];
  if (data.upstream) bits.push(`suit ${data.upstream}`);
  if (data.ahead) bits.push(`${data.ahead} devant`);
  if (data.behind) bits.push(`${data.behind} derrière`);
  bits.push(data.dirty ? `${data.dirty} modifié${data.dirty > 1 ? 's' : ''}` : 'propre');
  // Fraîcheur du clone. Sans elle, un panneau qui lit un dépôt en retard n'affiche rien de
  // faux mais laisse croire qu'il n'y a rien de plus récent — et on lui fait confiance.
  if (data.fetchFailed) bits.push('références distantes non rafraîchies');
  else if (data.fetchedAgeMs != null) bits.push(`à jour ${fetchedAgo(data.fetchedAgeMs)}`);
  $('#git-state').textContent = bits.join(' · ');
  $('#git-state').title = data.fetchFailed
    ? `Le fetch a échoué : ${data.fetchFailed}`
    : 'Les références distantes sont rafraîchies à l’ouverture du panneau.';

  if (data.empty || !data.rows.length) {
    body.innerHTML = '<div class="empty">Aucun commit.</div>';
    return;
  }

  const inset = Math.min(data.columns, GIT_LANES_MAX) * GIT_LANE_W + 8;
  const rows = data.rows
    .map((r) => {
      const refs = r.refs.map(gitRefChip).join('');
      const when = r.at ? whenLabel(r.at) : '';
      // L'auteur est montré deux fois de deux façons : la pastille se lit d'un coup d'œil en
      // balayant la colonne, le nom nomme. L'adresse reste en infobulle — c'est elle qui départage
      // deux identités du même nom, mais elle est trop longue pour la ligne.
      const tip = [r.short, r.email ? `${r.author} <${r.email}>` : r.author, when]
        .filter(Boolean)
        .join(' · ');
      return `<div class="git-row" style="height:${GIT_ROW_H}px" title="${esc(tip)}">${refs}${gitAvatar(
        r
      )}<span class="git-subject">${esc(r.subject || '')}</span><span class="git-by">${esc(
        r.author || ''
      )}</span><span class="git-when">${esc(when)}</span></div>`;
    })
    .join('');

  body.innerHTML =
    `<div class="git-plot" style="padding-left:${inset}px">${gitCanvas(data)}${rows}</div>` +
    (data.truncated ? `<div class="git-more">Limité aux ${data.limit} derniers commits.</div>` : '');
  hydrateGitAvatars(body.querySelector('.git-plot'));
}

/** Âge du dernier fetch, en clair. « à l'instant » vaut mieux que « il y a 0 minute ». */
function fetchedAgo(ms) {
  const s = Math.round(ms / 1000);
  if (s < 45) return 'à l’instant';
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

/**
 * @param {boolean} [force] rafraîchir les références distantes sans attendre le délai de
 *   grâce — c'est ce que fait le bouton de rafraîchissement.
 */
async function loadGitPanel(force) {
  const id = state.currentId;
  if (!id) return;
  const body = $('#git-body');
  // Le fetch passe par le réseau : le dire, sinon l'attente ressemble à une panne.
  body.innerHTML = '<div class="empty">Lecture du dépôt…</div>';

  // La limite est celle du serveur : la fixer ici la ferait dériver de sa borne.
  const params = [];
  if (force) params.push('fetch=1');
  const query = params.length ? `?${params.join('&')}` : '';
  let data;
  try {
    data = await api('GET', `/api/conversations/${id}/git${query}`);
  } catch (err) {
    if (state.currentId === id) body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  if (state.currentId !== id) return;
  renderGit(data);
}

// Largeur du panneau : une préférence d'affichage, donc dans le navigateur, comme le filtre
// par agent et les sections repliées. Redimensionner depuis le PC ne doit rien changer au
// téléphone, où le panneau est de toute façon en plein écran.
const GIT_WIDTH_DEFAULT = 520;
const NOTES_WIDTH_DEFAULT = 420;
// Plus large que le bloc-notes : on y lit des documents et on y regarde des diagrammes, deux
// choses qu'une colonne de 420 px rend inconfortables.
const PLANS_WIDTH_DEFAULT = 560;
const PANEL_WIDTH_MIN = 300;

/**
 * Rend un tiroir redimensionnable par sa poignée. Deux tiroirs partagent ce code — le graphe
 * git et le bloc-notes —, avec chacun sa largeur retenue : régler l'un ne doit pas déplacer
 * l'autre, et régler sur le PC ne doit rien changer au téléphone, où ils sont plein écran.
 *
 * `setPointerCapture` plutôt qu'un écouteur sur le document : sans lui, sortir du panneau
 * pendant le glissement perd les événements et la poignée reste collée au curseur.
 */
function installGrip({ panel, grip, prefKey, defaultWidth }) {
  const apply = (px) => {
    const max = Math.max(PANEL_WIDTH_MIN, window.innerWidth - 420);
    const width = Math.round(Math.min(Math.max(px, PANEL_WIDTH_MIN), max));
    $(panel).style.setProperty('--git-width', `${width}px`);
    return width;
  };
  apply(PREFS.read(prefKey, defaultWidth));

  $(grip).addEventListener('pointerdown', (e) => {
    const startX = e.clientX;
    const startWidth = $(panel).getBoundingClientRect().width;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');

    const onMove = (ev) => apply(startWidth - (ev.clientX - startX));
    const onUp = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      PREFS.write(prefKey, $(panel).getBoundingClientRect().width);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    e.preventDefault();
  });

  $(grip).addEventListener('dblclick', () => PREFS.write(prefKey, apply(defaultWidth)));
  return apply;
}

installGrip({
  panel: '#git-panel',
  grip: '#git-grip',
  prefKey: 'gitWidth',
  defaultWidth: GIT_WIDTH_DEFAULT,
});
installGrip({
  panel: '#notes-panel',
  grip: '#notes-grip',
  prefKey: 'notesWidth',
  defaultWidth: NOTES_WIDTH_DEFAULT,
});
installGrip({
  panel: '#plans-panel',
  grip: '#plans-grip',
  prefKey: 'plansWidth',
  defaultWidth: PLANS_WIDTH_DEFAULT,
});

$('#btn-git').addEventListener('click', () => {
  const opening = $('#git-panel').classList.contains('hidden');
  // Un seul tiroir à la fois : deux colonnes en plus du fil ne laisseraient de place à
  // aucune des trois, et sous 860 px elles se masqueraient l'une l'autre.
  closeNotesPanel();
  $('#git-panel').classList.toggle('hidden', !opening);
  $('#git-grip').classList.toggle('hidden', !opening);
  $('#btn-git').classList.toggle('on', opening);
  if (opening) loadGitPanel();
});

$('#btn-git-close').addEventListener('click', closeGitPanel);
// Le bouton force le fetch : c'est justement ce qu'on lui demande quand on doute de la
// fraicheur de ce qui est affiche.
$('#btn-git-refresh').addEventListener('click', () => loadGitPanel(true));

$('#btn-notes').addEventListener('click', () => {
  const opening = $('#notes-panel').classList.contains('hidden');
  closeGitPanel();
  closePlansPanel();
  $('#notes-panel').classList.toggle('hidden', !opening);
  $('#notes-grip').classList.toggle('hidden', !opening);
  $('#btn-notes').classList.toggle('on', opening);
  if (opening) loadNotes();
});

$('#btn-notes-close').addEventListener('click', closeNotesPanel);

$('#btn-plans').addEventListener('click', () => {
  const opening = $('#plans-panel').classList.contains('hidden');
  closeGitPanel();
  closeNotesPanel();
  $('#plans-panel').classList.toggle('hidden', !opening);
  $('#plans-grip').classList.toggle('hidden', !opening);
  $('#btn-plans').classList.toggle('on', opening);
  if (opening) window.plansPanel.open();
});

$('#btn-plans-close').addEventListener('click', closePlansPanel);

// --- Regarder la page de l'agent --------------------------------------------
//
// Le navigateur des agents est un service à part, partagé par tous. On le photographie
// à travers lui, sans le déranger : voir `lib/watch-browser.js`.

const WATCH_FRAME_MS = 1200;
// L'adresse change bien moins souvent que l'image, et la demander coûte un appel d'outil
// de plus au service que l'agent est en train d'utiliser.
const WATCH_URL_EVERY = 5;

let watchTimer = null;
let watchTicks = 0;

/** Le bouton n'apparaît que là où il y a quelque chose à regarder. */
function renderWatchToggle() {
  const c = state.current;
  const models = state.models || {};
  const has =
    Boolean(c && c.browser) || (models.browserAlways || []).includes(c && c.provider);
  $('#btn-watch').classList.toggle('hidden', !has);
}

function watchState(text) {
  $('#watch-state').textContent = text || '';
}

async function watchTick() {
  try {
    // L'horodatage casse le cache : sans lui le navigateur reservirait la même image.
    const res = await fetch(`/api/browser/live/frame?t=${Date.now()}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'indisponible');
    const blob = await res.blob();
    const img = $('#watch-img');
    const old = img.src;
    img.src = URL.createObjectURL(blob);
    // L'ancienne image est révoquée après le remplacement : la révoquer avant ferait
    // clignoter la vue à chaque rafraîchissement.
    if (old.startsWith('blob:')) URL.revokeObjectURL(old);
    watchState(res.headers.get('X-Frame-Stale') ? "l'agent utilise le navigateur…" : '');
  } catch (err) {
    watchState(err.message);
  }

  if (watchTicks % WATCH_URL_EVERY === 0) {
    try {
      const { tab } = await api('GET', '/api/browser/live');
      $('#watch-url').textContent = tab.url || 'page inconnue';
      $('#watch-url').title = tab.title || '';
    } catch {
      /* l'image suffit : une adresse manquante n'empêche pas de regarder */
    }
  }
  watchTicks += 1;
}

function openWatch() {
  $('#watch-modal').classList.remove('hidden');
  watchTicks = 0;
  watchState('connexion…');
  watchTick();
  watchTimer = setInterval(watchTick, WATCH_FRAME_MS);
}

function closeWatch() {
  clearInterval(watchTimer);
  watchTimer = null;
  $('#watch-modal').classList.add('hidden');
  const img = $('#watch-img');
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  img.removeAttribute('src');
}

$('#btn-watch').addEventListener('click', openWatch);
$('#btn-watch-close').addEventListener('click', closeWatch);
// Un onglet en arrière-plan n'a personne pour regarder : inutile de continuer à solliciter
// le navigateur de l'agent.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' && watchTimer) closeWatch();
});

// --- Bloc-notes du projet ---------------------------------------------------
//
// Les tickets appartiennent au projet, pas à la conversation : le panneau montre donc la
// même chose depuis n'importe quelle conversation du même dépôt, agents compris.

/** Ticket en cours d'édition dans le formulaire ; null quand il sert à en créer un. */
let noteEditId = null;
/** Images choisies mais pas encore envoyées, en data URL. */
let notePending = [];
/** Ticket dont le choix « Prompt » est déplié. */
let notePromptOpen = null;

function notesError(text) {
  $('#notes-error').textContent = text || '';
}

async function loadNotes() {
  if (!state.currentId) return;
  try {
    const data = await api('GET', `/api/notes?convId=${state.currentId}`);
    state.notesProject = data.project;
    state.notes = data.tickets || [];
    renderNotes();
  } catch (err) {
    $('#notes-body').innerHTML = `<div class="notes-empty">${esc(err.message)}</div>`;
  }
}

/**
 * Recharge la todo sans rien afficher de l'échec.
 *
 * Appelée à l'ouverture d'une conversation, seulement pour savoir quelles idées du fil y
 * sont déjà : le panneau est fermé, une erreur écrite dedans ne serait vue par personne, et
 * le pire qui puisse arriver est un bouton « ajouter » sur une idée déjà ajoutée.
 */
function loadNotesQuietly() {
  loadNotes().catch(() => {});
}

function renderNotes() {
  const tickets = state.notes || [];
  const open = tickets.filter((t) => t.status !== 'done').length;
  $('#notes-count').textContent = tickets.length
    ? `${open} ouvert(s) · ${tickets.length} au total`
    : '';
  // Les cartes d'idée du fil suivent la todo : c'est le seul endroit traversé par tous les
  // chemins qui la font changer — création, agent, autre appareil.
  refreshIdeaButtons();

  if (!tickets.length) {
    $('#notes-body').innerHTML =
      '<div class="notes-empty">Rien de noté pour ce projet.<br>Le + ajoute un ticket.</div>';
    return;
  }

  const groups = [
    ['todo', 'À faire'],
    ['doing', 'En cours'],
    ['done', 'Fait'],
  ];
  $('#notes-body').innerHTML = groups
    .map(([status, label]) => {
      const rows = tickets.filter((t) => t.status === status);
      if (!rows.length) return '';
      return `<div class="notes-group">${label} · ${rows.length}</div>${rows.map(noteCard).join('')}`;
    })
    .join('');
}

function noteCard(t) {
  const images = (t.images || [])
    .map((i) => `<img src="${esc(i.url)}" alt="${esc(i.name)}" data-note-img="${esc(i.url)}" title="${esc(i.name)}">`)
    .join('');
  const options = [
    ['todo', 'À faire'],
    ['doing', 'En cours'],
    ['done', 'Fait'],
  ]
    .map(([v, l]) => `<option value="${v}"${t.status === v ? ' selected' : ''}>${l}</option>`)
    .join('');

  // Le choix du destinataire n'est déplié que pour un ticket à la fois : deux menus ouverts
  // dans une colonne étroite se liraient comme un seul.
  const send =
    notePromptOpen === t.id
      ? `<div class="note-send">
           <button data-note-here="${esc(t.id)}">Dans cette conversation</button>
           <button data-note-new="${esc(t.id)}">Nouvelle conversation</button>
           <button class="note-team" data-note-team="${esc(t.id)}">Une équipe de trois</button>
         </div>`
      : '';

  return `<div class="note" data-status="${esc(t.status)}">
    <strong class="note-title">${esc(t.title)}</strong>
    ${t.body ? `<p class="note-desc">${esc(t.body)}</p>` : ''}
    ${images ? `<div class="note-images">${images}</div>` : ''}
    <div class="note-row">
      <select class="note-status" data-note-status="${esc(t.id)}" title="État">${options}</select>
      <button class="ghost" data-note-edit="${esc(t.id)}" title="Modifier">
        <svg class="icon"><use href="#i-pencil"/></svg>
      </button>
      <button class="ghost" data-note-del="${esc(t.id)}" title="Supprimer">
        <svg class="icon"><use href="#i-trash"/></svg>
      </button>
      <button class="note-prompt" data-note-prompt="${esc(t.id)}">Prompt</button>
    </div>
    ${send}
  </div>`;
}

/** Ouvre le formulaire, vide pour créer ou rempli pour modifier. */
function openNoteForm(ticket) {
  noteEditId = ticket ? ticket.id : null;
  notePending = [];
  $('#note-title').value = ticket ? ticket.title : '';
  $('#note-body').value = ticket ? ticket.body || '' : '';
  $('#btn-note-save').textContent = ticket ? 'Enregistrer' : 'Ajouter';
  $('#notes-form').classList.remove('hidden');
  renderNoteAttachments();
  notesError('');
  $('#note-title').focus();
}

function closeNoteForm() {
  noteEditId = null;
  notePending = [];
  $('#notes-form').classList.add('hidden');
  notesError('');
}

function renderNoteAttachments() {
  const box = $('#note-attachments');
  box.classList.toggle('hidden', !notePending.length);
  box.innerHTML = notePending
    .map((i) => `<img src="${esc(i.dataUrl)}" alt="${esc(i.name)}" title="${esc(i.name)}">`)
    .join('');
}

$('#btn-note-add').addEventListener('click', () => {
  if ($('#notes-form').classList.contains('hidden') || noteEditId) openNoteForm(null);
  else closeNoteForm();
});

$('#btn-note-cancel').addEventListener('click', closeNoteForm);

$('#btn-note-image').addEventListener('click', () => $('#note-file').click());

$('#note-file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = ''; // permet de re-choisir le même fichier
  for (const file of files) {
    try {
      notePending.push({ name: file.name, dataUrl: await fileToDataUrl(file) });
    } catch {
      notesError(`${file.name} : lecture impossible.`);
    }
  }
  renderNoteAttachments();
});

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('lecture impossible'));
    reader.readAsDataURL(file);
  });
}

$('#btn-note-save').addEventListener('click', async () => {
  const title = $('#note-title').value.trim();
  if (!title) return notesError('Un titre, au minimum.');
  const body = { title, body: $('#note-body').value.trim(), images: notePending };
  $('#btn-note-save').disabled = true;
  try {
    if (noteEditId) await api('POST', `/api/notes/${noteEditId}`, body);
    else await api('POST', '/api/notes', { ...body, convId: state.currentId });
    closeNoteForm();
    // La liste arrive par le websocket, mais on ne l'attend pas : le geste doit se voir
    // tout de suite, y compris si la diffusion se perd.
    await loadNotes();
  } catch (err) {
    notesError(err.message);
  } finally {
    $('#btn-note-save').disabled = false;
  }
});

$('#notes-body').addEventListener('change', async (e) => {
  const select = e.target.closest('[data-note-status]');
  if (!select) return;
  try {
    await api('POST', `/api/notes/${select.dataset.noteStatus}`, { status: select.value });
    await loadNotes();
  } catch (err) {
    toastError(err.message);
    loadNotes();
  }
});

$('#notes-body').addEventListener('click', async (e) => {
  const find = (attr) => {
    const el = e.target.closest(`[data-note-${attr}]`);
    return el ? el.dataset[`note${attr[0].toUpperCase()}${attr.slice(1)}`] : null;
  };

  const img = find('img');
  if (img) return openLightbox(img, 'Image du ticket');

  const edit = find('edit');
  if (edit) return openNoteForm((state.notes || []).find((t) => t.id === edit));

  const del = find('del');
  if (del) {
    const ticket = (state.notes || []).find((t) => t.id === del);
    return void undoToast({
      message: `« ${ticket ? ticket.title : 'Ticket'} » supprimé`,
      hide: e.target.closest('.note'),
      run: async () => {
        await api('DELETE', `/api/notes/${del}`);
        if (noteEditId === del) closeNoteForm();
        await loadNotes();
      },
    });
  }

  const prompt = find('prompt');
  if (prompt) {
    notePromptOpen = notePromptOpen === prompt ? null : prompt;
    return renderNotes();
  }

  const here = find('here');
  if (here) return sendTicket(here, false);
  const fresh = find('new');
  if (fresh) return sendTicket(fresh, true);
  const crew = find('team');
  if (crew) return startTeam(crew);
});

/**
 * Lance les trois agents sur un ticket.
 *
 * Confirmé avant de partir : ce sont trois turns qui s'enchaînent tout seuls, dont deux
 * partiront sans que personne ne regarde. Le bouton est à côté de « Prompt », il se clique
 * par mégarde.
 */
async function startTeam(id) {
  const ticket = (state.notes || []).find((t) => t.id === id);
  const provider = (state.current && state.current.provider) || 'claude';
  const ok = await askConfirm({
    title: `Lancer une équipe sur « ${ticket ? ticket.title : 'ce ticket'} » ?`,
    body:
      "Trois conversations vont s'enchaîner : un plan, une réalisation sur une branche " +
      'isolée, puis une relecture par un autre agent.\n\n' +
      'Les deux dernières partent seules, sans que personne ne regarde.',
    ok: 'Lancer les trois',
  });
  if (!ok) return;

  notePromptOpen = null;
  renderNotes();
  try {
    const { run } = await api('POST', `/api/notes/${id}/team`, { provider });
    // On ouvre la première étape : c'est là que ça se passe, et la sidebar imbriquera les
    // deux suivantes dessous à mesure qu'elles naissent.
    await refreshList();
    if (run && run.convs && run.convs.plan) await openConv(run.convs.plan);
  } catch (err) {
    toastError(err.message);
  }
}

/**
 * Envoie un ticket à un agent : dans la conversation ouverte, ou dans une nouvelle.
 *
 * La consigne est composée côté serveur. Elle porte l'identifiant du ticket, ce qui permet
 * à l'agent de le passer en « fait » sans avoir à deviner lequel c'était.
 */
async function sendTicket(id, asNew) {
  notePromptOpen = null;
  renderNotes();
  try {
    const { prompt } = await api('GET', `/api/notes/${id}/prompt`);
    if (asNew) {
      const data = await api('POST', '/api/conversations', {
        provider: state.current.provider,
        // Le projet, pas le dossier de travail : depuis une conversation isolée, la
        // nouvelle doit partir du dépôt et non du worktree de la précédente.
        cwd: state.notesProject,
        model: state.current.model || null,
        effort: state.current.effort || null,
        prompt,
      });
      await refreshList();
      await openConv(data.conversation.id);
    } else {
      await api('POST', `/api/conversations/${state.currentId}/messages`, { prompt });
    }
  } catch (err) {
    toastError(err.message);
  }
}

// Jauge de fenêtre de contexte. La valeur vient du prompt du dernier appel API du
// turn précédent : c'est une mesure, pas une estimation, mais elle ne bouge qu'à la
// fin de chaque turn.
function renderContext() {
  const c = state.current;
  const ring = $('#ctx-ring');
  if (!c || !c.contextTokens) {
    ring.classList.add('hidden');
    renderContextActions(null);
    return;
  }
  // Sans fenêtre annoncée (cas de Codex), on affiche la valeur absolue : mieux vaut
  // un chiffre exact qu'un pourcentage calculé sur un plafond supposé.
  if (!c.contextWindow) {
    ring.classList.remove('hidden');
    ring.classList.remove('hot');
    ring.title = `${nf.format(c.contextTokens)} tokens de contexte au dernier turn. ${
      c.provider === 'codex' ? 'Codex ne publie pas la taille de sa fenêtre.' : ''
    }`;
    ring.innerHTML = `<span>${fmtTokens(c.contextTokens)} de contexte</span>`;
    renderContextActions(null);
    return;
  }
  const pct = Math.min(100, (c.contextTokens / c.contextWindow) * 100);
  const color = pct >= 85 ? 'var(--red)' : pct >= 65 ? 'var(--amber)' : 'var(--accent)';
  ring.classList.remove('hidden');
  ring.classList.toggle('hot', pct >= 85);
  ring.title =
    `${nf.format(c.contextTokens)} tokens sur ${nf.format(c.contextWindow)} · relevé à la fin du dernier turn.` +
    (pct >= 65 ? ' Utilise Compacter, ou Reprendre léger si la session est déjà morte.' : '');

  const label = `${fmtTokens(c.contextTokens)} / ${fmtTokens(c.contextWindow)} · ${Math.round(pct)} %`;
  const dial = ring.querySelector('.ctx-dial');
  if (dial) {
    // On met à jour au lieu de remplacer, pour que --pct puisse s'animer.
    dial.style.setProperty('--pct', pct.toFixed(1));
    dial.style.setProperty('--ring', color);
    ring.querySelector('.ctx-label').textContent = label;
  } else {
    ring.innerHTML =
      `<span class="ctx-dial" style="--pct:${pct.toFixed(1)};--ring:${color}"></span>` +
      `<span class="ctx-label">${label}</span>`;
  }
  renderContextActions(pct);
}

/**
 * Boutons Compacter / Reprendre léger, calés sur les capacités du provider et l'état
 * de la conversation. Compacter reste caché chez Codex ; Reprendre léger apparaît dès
 * qu'il y a quelque chose à transmettre.
 */
function renderContextActions(pct) {
  const c = state.current;
  const compactBtn = $('#btn-compact');
  const resumeBtn = $('#btn-resume-light');
  const mobileCompact = $('#mobile-action-compact');
  const mobileResume = $('#mobile-action-resume-light');
  if (!c) {
    compactBtn.classList.add('hidden');
    resumeBtn.classList.add('hidden');
    mobileCompact.classList.add('hidden');
    mobileResume.classList.add('hidden');
    return;
  }

  const compactable = ((state.models && state.models.compactable) || []).includes(c.provider);
  const hasUser = (c.items || []).some((it) => it.kind === 'user');
  const hot = typeof pct === 'number' ? pct >= 65 : false;

  compactBtn.classList.toggle('hidden', !compactable || !c.sessionStarted);
  compactBtn.classList.toggle('ctx-hot-action', compactable && hot);
  mobileCompact.classList.toggle('hidden', !compactable || !c.sessionStarted);

  resumeBtn.classList.toggle('hidden', !hasUser);
  resumeBtn.classList.toggle('ctx-hot-action', hot || c.status === 'error');
  mobileResume.classList.toggle('hidden', !hasUser);
}

$('#conv-model').addEventListener('change', async (e) => {
  if (!state.currentId || !state.current) return;
  const model = e.target.value;
  const provider = state.current.provider;
  const allowed = effortList(provider, model);
  const effortOk =
    !state.current.effort || allowed.some((item) => item.value === state.current.effort);
  const patch = { model };
  // Un effort que la nouvelle version refuse ferait échouer le prochain message.
  if (!effortOk) patch.effort = '';
  try {
    await api('PATCH', `/api/conversations/${state.currentId}`, patch);
    state.current.model = model || null;
    if (!effortOk) state.current.effort = null;
    renderHead();
  } catch (err) {
    toastError(err.message);
    renderHead();
  }
});

$('#conv-effort').addEventListener('change', async (e) => {
  if (!state.currentId) return;
  const effort = e.target.value;
  try {
    await api('PATCH', `/api/conversations/${state.currentId}`, { effort });
    state.current.effort = effort || null;
  } catch (err) {
    toastError(err.message);
  }
});

$('#btn-compact').addEventListener('click', async () => {
  if (!state.currentId || !state.current) return;
  try {
    const data = await api('POST', `/api/conversations/${state.currentId}/compact`, {});
    toast(
      data.queued
        ? 'Compactage mis en file — il partira après le turn en cours.'
        : 'Compactage lancé (/compact).'
    );
  } catch (err) {
    toastError(err.message);
  }
});

$('#btn-resume-light').addEventListener('click', () => {
  if (!state.currentId || !state.current) return;
  const dead = state.current.status === 'error';
  openModal(
    'Reprendre léger',
    `<p>Crée une <strong>nouvelle conversation</strong> avec une note de passation,
     sans recopier la session CLI (donc sans le contexte saturé).</p>
     <p class="hint">${
       dead
         ? 'Cette conversation est en erreur : la note sera synthétisée depuis le fil, sans redemander un turn au parent.'
         : 'Si le parent peut encore répondre, il rédige la note ; sinon une note synthétique est écrite automatiquement.'
     }</p>
     <div class="field"><label for="resume-light-prompt">Consigne pour l'enfant</label>
       <textarea id="resume-light-prompt" rows="3">Reprends le travail à partir de la note de passation. Ne repose pas les questions déjà tranchées ; enchaîne sur ce qui reste à faire.</textarea>
     </div>`,
    'Créer la reprise',
    async () => {
      const prompt = ($('#resume-light-prompt') && $('#resume-light-prompt').value.trim()) || '';
      $('#modal-ok').textContent = dead ? 'Note synthétique…' : 'Note de passation…';
      const data = await api('POST', `/api/conversations/${state.currentId}/resume-light`, {
        prompt: prompt || undefined,
        synthetic: dead || undefined,
      });
      await refreshList();
      await openConv(data.conversation.id);
      toast(
        data.synthetic
          ? 'Reprise créée avec une note synthétique.'
          : 'Reprise créée avec la note de l’agent.'
      );
    }
  );
});

$('#btn-browser').addEventListener('click', async () => {
  if (!state.currentId || !state.current) return;
  const next = !state.current.browser;
  try {
    await api('PATCH', `/api/conversations/${state.currentId}`, { browser: next });
    state.current.browser = next;
    renderBrowserToggle();
  } catch (err) {
    toastError(err.message);
  }
});

// --- Quotas d'abonnement --------------------------------------------------

// Les quotas affichés suivent le provider du contexte : celui de la conversation
// ouverte, ou celui sélectionné sur l'écran de création.
function activeProvider() {
  return state.current ? state.current.provider : state.provider;
}

let limitsRetry = null;

async function renderLimits(force) {
  const provider = activeProvider();
  // Interroger le quota d'un fournisseur auquel on n'est pas connecté ne peut que
  // produire une erreur : on n'affiche rien plutôt qu'un échec.
  if (!providerUsable(provider)) {
    $('#limits').innerHTML = '';
    return;
  }
  let data;
  try {
    data = await api('GET', `/api/limits?provider=${provider}${force ? '&force=1' : ''}`);
  } catch {
    return;
  }
  // Le provider a pu changer pendant la requête (Codex met ~12 s).
  if (provider !== activeProvider()) return;

  if (limitsRetry) {
    clearTimeout(limitsRetry);
    limitsRetry = null;
  }

  // Le nom du provider est capitalisé, pas le compte : « Dev@Example.Com » sinon.
  const head =
    `<div class="limit-head">${providerIcon(provider)}` +
    `<span class="limit-prov">${esc(provider)}</span>` +
    (data.account ? `<span class="limit-account">· ${esc(data.account)}</span>` : '') +
    `</div>`;

  if (data.pending) {
    $('#limits').innerHTML = `${head}<div class="limit-reset">Relevé en cours…</div>`;
    limitsRetry = setTimeout(() => renderLimits(), 6000);
    return;
  }

  if (!data.buckets || !data.buckets.length) {
    $('#limits').innerHTML = `${head}<div class="limit-reset">${esc(
      data.error ? 'Quotas indisponibles' : 'Aucun quota exposé'
    )}</div>`;
    return;
  }

  $('#limits').innerHTML =
    head +
    data.buckets
      .map((b) => {
        const cls = b.percent >= 90 ? ' hot' : b.percent >= 70 ? ' warn' : '';
        const at = b.resetsAt ? ` data-reset-at="${escAttr(b.resetsAt)}"` : '';
        return `<div class="limit-row"${at} title="${esc(resetTitle(b))}">
        <div class="limit-top"><span>${esc(b.label)}</span><span class="pct">${Math.round(
          b.percent
        )} %</span></div>
        <div class="limit-bar"><div class="limit-fill${cls}" style="width:${Math.min(
          100,
          b.percent
        )}%"></div></div>
      </div>`;
      })
      .join('') +
    (data.stale ? '<div class="limit-reset">valeur en cache, actualisation…</div>' : '');
}

// « Aug 6, 3:49pm » demande un calcul mental ; « dans 2 h 14 » se lit. On garde
// le texte brut du CLI en secours, pour ne rien perdre si le format change.
function resetTitle(bucket) {
  const left = bucket.resetsAt ? timeLeft(bucket.resetsAt) : null;
  if (left) return `Réinitialisation dans ${left}`;
  return bucket.resets ? `Réinitialisation : ${bucket.resets}` : '';
}

function timeLeft(iso, now = Date.now()) {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'un instant';

  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'moins d’une minute';
  if (mins < 60) return `${mins} min`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rest = mins % 60;
    return rest ? `${hours} h ${String(rest).padStart(2, '0')}` : `${hours} h`;
  }

  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} j ${rest} h` : `${days} j`;
}

// Le relevé n'est rafraîchi que toutes les deux minutes ; la durée restante, elle,
// change en continu. On la recalcule sur place, sans rappeler l'API.
function refreshResetTitles() {
  document.querySelectorAll('#limits .limit-row[data-reset-at]').forEach((row) => {
    const left = timeLeft(row.dataset.resetAt);
    if (left) row.title = `Réinitialisation dans ${left}`;
  });
}

function setRunning(running) {
  state.isRunning = running;
  $('#btn-send').classList.toggle('hidden', running);
  $('#btn-stop').classList.toggle('hidden', !running);
  if (running) showProcessing();
  else clearStreams();
}

function renderPromptModel() {
  const el = $('#prompt-model');
  const models = (state.current && state.current.lastModels) || [];
  el.textContent = models.join(' + ');
  el.title = models.length ? `Modèle utilisé au dernier turn : ${models.join(' + ')}` : '';
  el.classList.toggle('hidden', !models.length);
  el.closest('.prompt-shell').classList.toggle('has-model', Boolean(models.length));
}

async function openConv(id, focusItemId) {
  const data = await api('GET', `/api/conversations/${id}`);
  state.currentId = id;
  state.current = data.conversation;
  state.isRunning = data.running;
  state.queue = data.conversation.queue || [];
  state.ask = data.ask || null;
  editingQueueId = null;
  renderQueue();
  renderAskPending();

  showView('#conv-view');
  clearStreams();
  clearAttachments(); // les images en attente appartiennent à la conversation quittée
  // Le catalogue de skills dépend du fournisseur : sans attendre, l'autocomplétion serait
  // vide au premier « / » tapé après l'ouverture.
  loadSkills(data.conversation.provider);
  $('#skill-badge').classList.add('hidden');
  $('#skill-menu').classList.add('hidden');
  closeGitPanel(); // le graphe affiché est celui du projet qu'on quitte
  closeNotesPanel();
  closePlansPanel(); // idem : les plans affichés sont ceux du projet qu'on quitte
  closeNoteForm();
  if (watchTimer) closeWatch();
  // Le mode armé appartenait à la conversation qu'on quitte ; l'objectif en cours, lui, vient
  // du serveur avec la conversation.
  armGoal(false);
  renderGoalLive();
  renderHead();
  renderPromptModel();
  renderMessages();
  renderList();
  renderLimits();
  // Après `renderMessages` : c'est lui qui vient de poser les cartes d'idée que la todo
  // doit marquer.
  loadNotesQuietly();
  sendPresence(); // `showView` a été appelé avant que `state.currentId` ne soit à jour
  if (focusItemId) focusItem(focusItemId);
  await refreshList();
  if (!focusItemId) $('#prompt').focus();
}

function showNew() {
  state.currentId = null;
  state.current = null;
  showView('#new-view');
  const active = renderProviderPick('#provider-pick', state.provider);
  if (active && active !== state.provider) {
    state.provider = active;
    renderModels();
  }
  renderNoProvider();
  renderList();
  renderLimits();
  $('#new-prompt').focus();
}

// --- Consommation ---------------------------------------------------------

const nf = new Intl.NumberFormat('fr-FR');

function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} Md`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} k`;
  return nf.format(n);
}

function fmtUsd(n) {
  if (!n) return '$0';
  return n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

function monthLabel(month) {
  if (month === 'all') return 'Tout';
  const [year, m] = month.split('-');
  return `${['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'][Number(m) - 1]} ${year}`;
}

/** Dernier segment d'un chemin de projet : c'est ce qu'on lit, le reste va en infobulle. */
function projectLabel(p) {
  if (!p) return 'Hors projet';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

function weekLabel(week) {
  const [y, m, d] = week.split('-').map(Number);
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

/**
 * Les trois blocs qui répondent à « où part l'argent ».
 *
 * Des barres proportionnelles au plus gros, et non un graphique : il n'y a pas de
 * bibliothèque dans cette application, et une barre en CSS se lit aussi bien qu'une courbe
 * pour comparer douze semaines.
 */
function renderBoard(data) {
  const weeks = data.weeks || [];
  const peak = Math.max(...weeks.map((w) => w.costUsd), 0.000001);
  $('#usage-weeks').innerHTML = weeks.length
    ? `<h3 class="board-title">Par semaine</h3>
      <div class="weeks">${weeks
        .map((w) => {
          const detail = Object.entries(w.providers || {})
            .sort((a, b) => b[1] - a[1])
            .map(([name, cost]) => `${name} ${fmtUsd(cost)}`)
            .join(' · ');
          return `<div class="week" title="Semaine du ${esc(w.week)} — ${esc(detail || 'aucun coût')}\n${nf.format(w.tokens)} tokens, ${nf.format(w.turns)} turns">
            <div class="week-bar"><span style="height:${Math.max(2, (w.costUsd / peak) * 100)}%"></span></div>
            <div class="week-cost">${fmtUsd(w.costUsd)}</div>
            <div class="week-label">${weekLabel(w.week)}</div>
          </div>`;
        })
        .join('')}</div>`
    : '';

  const projects = data.projects || [];
  const widest = Math.max(...projects.map((p) => p.costUsd), 0.000001);
  $('#usage-projects').innerHTML = projects.length
    ? `<h3 class="board-title">Par projet</h3>
      <div class="bars">${projects
        .map(
          (p) => `<div class="bar-row" title="${esc(p.project || 'Conversations supprimées, ou sans projet')}">
            <span class="bar-name">${esc(projectLabel(p.project))}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${(p.costUsd / widest) * 100}%"></span></span>
            <span class="bar-num">${fmtUsd(p.costUsd)}</span>
            <span class="bar-note">${nf.format(p.convs)} conv. · ${fmtTokens(p.tokens)} tok</span>
          </div>`
        )
        .join('')}</div>`
    : '';

  const top = data.top || [];
  $('#usage-top').innerHTML = top.length
    ? `<h3 class="board-title">Conversations les plus chères</h3>
      <div class="table-wrap"><table class="models">
        <thead><tr><th>Conversation</th><th>Projet</th><th>Turns</th><th>Tokens</th><th>Équiv. API</th></tr></thead>
        <tbody>${top
          .map(
            (c) => `<tr${c.missing ? '' : ` class="clickable" data-usage-conv="${esc(c.convId)}"`}>
            <td>${providerIcon(c.provider)} ${
              c.missing
                ? '<span class="muted-text">conversation supprimée</span>'
                : `<span class="model-name">${esc(c.title || 'sans titre')}</span>`
            }</td>
            <td class="muted-text">${esc(projectLabel(c.project))}</td>
            <td>${nf.format(c.turns)}</td>
            <td>${fmtTokens(c.tokens)}</td>
            <td>${fmtUsd(c.costUsd)}</td>
          </tr>`
          )
          .join('')}</tbody>
      </table></div>`
    : '';
}

function renderUsage(data) {
  state.usageMonth = data.month;

  $('#month-tabs').innerHTML = ['all', ...data.months]
    .map(
      (m) =>
        `<button class="month-tab${m === data.month ? ' active' : ''}" data-month="${m}">${monthLabel(m)}</button>`
    )
    .join('');

  const t = data.totals;
  $('#usage-totals').innerHTML = [
    { label: 'Tokens au total', value: fmtTokens(t.tokens), note: `${nf.format(t.tokens)} exactement` },
    { label: 'Équivalent API', value: fmtUsd(t.costUsd), accent: true, note: 'si facturé au token' },
    { label: 'Turns', value: nf.format(t.turns) },
    {
      label: 'Entrée / Sortie',
      value: `${fmtTokens(t.inputTokens)} / ${fmtTokens(t.outputTokens)}`,
      note: `cache : ${fmtTokens(t.cacheCreateTokens)} écrit, ${fmtTokens(t.cacheReadTokens)} lu`,
    },
  ]
    .map(
      (tile) => `<div class="tile">
        <div class="tile-label">${tile.label}</div>
        <div class="tile-value${tile.accent ? ' accent' : ''}">${tile.value}</div>
        ${tile.note ? `<div class="tile-note">${esc(tile.note)}</div>` : ''}
      </div>`
    )
    .join('');

  renderBoard(data);

  $('#usage-providers').innerHTML = data.providers.length
    ? data.providers
        .map(
          (p) => `<details class="prov" ${data.providers.length === 1 ? 'open' : ''}>
        <summary>
          ${providerIcon(p.provider)}
          <span class="prov-name">${esc(p.provider)}</span>
          <span class="prov-num">${fmtTokens(p.tokens)} tok</span>
          <span class="prov-num cost">${fmtUsd(p.costUsd)}</span>
        </summary>
        <div class="prov-body"><div class="table-wrap"><table class="models">
          <thead><tr>
            <th>Modèle</th><th>Turns</th><th>Entrée</th><th>Sortie</th>
            <th>Cache écrit</th><th>Cache lu</th><th>Total tok</th><th>Équiv. API</th>
          </tr></thead>
          <tbody>${p.models
            .map(
              (m) => `<tr>
              <td><span class="model-name">${esc(m.model)}</span>${
                m.costSource !== 'provider'
                  ? `<span class="badge-src">${m.costSource === 'table' ? 'prix estimé' : 'prix inconnu'}</span>`
                  : ''
              }</td>
              <td>${nf.format(m.turns)}</td>
              <td>${fmtTokens(m.inputTokens)}</td>
              <td>${fmtTokens(m.outputTokens)}</td>
              <td>${fmtTokens(m.cacheCreateTokens)}</td>
              <td>${fmtTokens(m.cacheReadTokens)}</td>
              <td>${fmtTokens(m.tokens)}</td>
              <td>${fmtUsd(m.costUsd)}</td>
            </tr>`
            )
            .join('')}</tbody>
        </table></div></div>
      </details>`
        )
        .join('')
    : '<div class="empty">Aucune consommation enregistrée pour cette période.</div>';

  $('#usage-sub').textContent =
    data.month === 'all'
      ? 'Depuis le premier turn'
      : `Mois de ${monthLabel(data.month)} · ${nf.format(t.turns)} turns`;
}

const VIEWS = [
  '#new-view',
  '#usage-view',
  '#conv-view',
  '#triggers-view',
  '#skills-view',
  '#connections-view',
  '#gallery-view',
  '#server-view',
  '#settings-view',
];

// --- Serveur ---------------------------------------------------------------
//
// Tout vient d'adminPanel. Rien n'est recalculé ici : dupliquer ce que l'autre application
// sait faire est exactement ce qu'on voulait éviter en « centralisant ».

function fmtBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} To`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} Go`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} Mo`;
  return `${(bytes / 1e3).toFixed(0)} ko`;
}

function fmtUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days ? `${days} j ${hours} h` : `${hours} h`;
}

/** Un relevé en échec ne vide pas la page : il dit ce qu'il n'a pas pu lire, à sa place. */
function serverError(part, label) {
  return `<div class="empty">${esc(label)} — ${esc(part.error)}</div>`;
}

function renderServer(data) {
  // Le lien vers le panneau, avant tout le reste : il doit marcher même quand rien n'est
  // configuré, puisque c'est là qu'on va justement pour le configurer.
  if (data.webUrl) $('#server-open').href = data.webUrl;

  if (!data.available) {
    $('#server-sub').textContent = 'Panneau non configuré';
    $('#server-totals').innerHTML = '';
    $('#server-disk').innerHTML = `<div class="empty">
      Aucun jeton de service. Le créer une fois pour toutes, côté adminPanel :<br>
      <code>cd ./adminPanel &amp;&amp; node -e "console.log(require('./lib/service-token').generate())"</code><br>
      Il est en lecture seule : ce panneau ne peut rien changer d'ici.</div>`;
    for (const id of ['#server-pm2', '#server-services', '#server-sites']) $(id).innerHTML = '';
    return;
  }

  const sys = data.system || {};
  $('#server-sub').textContent = sys.hostname
    ? `${sys.hostname} · ${sys.platform} · node ${sys.nodeVersion}`
    : 'Relevé partiel';

  $('#server-totals').innerHTML = sys.error
    ? ''
    : [
        {
          label: 'Charge',
          value: (sys.loadAvg || [0])[0].toFixed(2),
          note: `${sys.cpuCount} cœurs · ${(sys.loadAvg || []).map((l) => l.toFixed(2)).join(' / ')}`,
        },
        {
          label: 'Mémoire',
          value: `${Math.round(((sys.memory || {}).used / (sys.memory || {}).total) * 100)} %`,
          note: `${fmtBytes((sys.memory || {}).used)} sur ${fmtBytes((sys.memory || {}).total)}`,
          accent: (sys.memory || {}).used / (sys.memory || {}).total > 0.9,
        },
        {
          label: 'Disque',
          value: `${Math.round(((sys.disk || {}).used / (sys.disk || {}).total) * 100)} %`,
          note: `${fmtBytes((sys.disk || {}).free)} libres`,
        },
        { label: 'En marche depuis', value: fmtUptime(sys.uptime || 0) },
      ]
        .map(
          (tile) => `<div class="tile">
            <div class="tile-label">${tile.label}</div>
            <div class="tile-value${tile.accent ? ' accent' : ''}">${esc(tile.value)}</div>
            ${tile.note ? `<div class="tile-note">${esc(tile.note)}</div>` : ''}
          </div>`
        )
        .join('');

  const disk = data.disk;
  $('#server-disk').innerHTML = disk.error
    ? serverError(disk, 'Disques')
    : `<h3 class="board-title">Disques</h3>
      <div class="bars">${disk
        .map(
          (d) => `<div class="bar-row" title="${esc(d.source)} · ${esc(d.fstype)}">
            <span class="bar-name">${esc(d.target)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${d.usedPercent}%"></span></span>
            <span class="bar-num">${d.usedPercent} %</span>
            <span class="bar-note">${fmtBytes(d.avail)} libres sur ${fmtBytes(d.size)}</span>
          </div>`
        )
        .join('')}</div>`;

  const pm2 = data.pm2;
  $('#server-pm2').innerHTML = pm2.error
    ? serverError(pm2, 'PM2')
    : (() => {
        // Ce qui ne tourne pas d'abord : c'est la seule ligne qu'on cherche quand on ouvre
        // cette page. Le reste est du contexte.
        const rows = [...pm2].sort((a, b) =>
          a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'online' ? 1 : -1
        );
        const down = rows.filter((p) => p.status !== 'online').length;
        return `<h3 class="board-title">PM2 — ${rows.length} process${down ? `, ${down} arrêté(s)` : ''}</h3>
          <div class="table-wrap"><table class="models">
            <thead><tr><th>Process</th><th>État</th><th>CPU</th><th>Mémoire</th><th>Redémarrages</th></tr></thead>
            <tbody>${rows
              .map(
                (p) => `<tr>
                  <td><span class="model-name">${esc(p.name)}</span></td>
                  <td><span class="srv-state srv-${p.status === 'online' ? 'on' : 'off'}">${esc(p.status)}</span></td>
                  <td>${p.cpu} %</td>
                  <td>${fmtBytes(p.memory)}</td>
                  <td>${p.restarts}</td>
                </tr>`
              )
              .join('')}</tbody>
          </table></div>`;
      })();

  const services = data.services;
  $('#server-services').innerHTML = services.error
    ? serverError(services, 'Services')
    : `<h3 class="board-title">Services</h3>
      <div class="srv-list">${services
        .map(
          (s) => `<div class="srv-row" title="${esc(s.description || '')}">
            <span class="srv-state srv-${s.active ? 'on' : 'off'}">${s.active ? 'actif' : esc(s.activeState || 'arrêté')}</span>
            <span class="srv-name">${esc(s.label || s.unit)}</span>
            <span class="srv-role">${esc(s.role || '')}</span>
            <span class="srv-mem">${s.memory ? fmtBytes(s.memory) : ''}</span>
          </div>`
        )
        .join('')}</div>`;

  const sites = data.sites;
  $('#server-sites').innerHTML = sites.error
    ? serverError(sites, 'Sites')
    : `<h3 class="board-title">Sites — ${sites.filter((s) => s.healthy).length}/${sites.length} en bonne santé</h3>
      <div class="srv-list">${sites
        .map(
          (s) => `<div class="srv-row" title="${esc((s.domains || []).join(', '))}">
            <span class="srv-state srv-${s.healthy ? 'on' : 'off'}">${s.status || '—'}</span>
            <span class="srv-name">${esc(s.primaryDomain || s.file)}</span>
            <span class="srv-role">${esc(s.type || '')}${s.port ? ` · :${s.port}` : ''}</span>
            <span class="srv-mem">${s.ms ? `${s.ms} ms` : esc(s.error || '')}</span>
          </div>`
        )
        .join('')}</div>`;
}

async function showServer() {
  showView('#server-view');
  state.currentId = null;
  renderList();
  $('#server-sub').textContent = 'Lecture…';
  try {
    renderServer(await api('GET', '/api/panel'));
  } catch (err) {
    $('#server-sub').textContent = '';
    $('#server-totals').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

$('#btn-server').addEventListener('click', () => {
  showServer();
  closeNav();
});
$('#btn-server-refresh').addEventListener('click', () => showServer());
$('#btn-server-back').addEventListener('click', () => document.body.classList.add('nav-open'));

/** N'affiche qu'une vue. Quatre vues à masquer une par une, c'était devenu à recopier. */
function showView(selector) {
  for (const view of VIEWS) $(view).classList.toggle('hidden', view !== selector);
  if (selector !== '#connections-view' && typeof stopRemoteBrowserFrames === 'function') {
    stopRemoteBrowserFrames();
  }
  // Quitter le fil pour la Consommation, c'est cesser de regarder la conversation : le
  // serveur doit l'apprendre, sinon il retiendrait une notification que plus personne
  // n'attend de voir à l'écran.
  if (typeof sendPresence === 'function') sendPresence();
}

async function showUsage(month) {
  const target = month || state.usageMonth || 'all';
  showView('#usage-view');
  state.currentId = null;
  renderList();
  try {
    renderUsage(await api('GET', `/api/usage?month=${encodeURIComponent(target)}`));
  } catch (err) {
    $('#usage-providers').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

$('#btn-usage').addEventListener('click', () => {
  showUsage();
  closeNav();
});
$('#btn-usage-refresh').addEventListener('click', () => showUsage());
$('#btn-usage-back').addEventListener('click', () => document.body.classList.add('nav-open'));
$('#month-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.month-tab');
  if (tab) showUsage(tab.dataset.month);
});

// Un classement dont on ne peut pas ouvrir les lignes oblige à retrouver la conversation à la
// main dans la barre latérale, ce qui est exactement ce qu'on venait d'éviter. Les
// conversations supprimées ne portent pas l'attribut : il n'y a rien à ouvrir.
$('#usage-top').addEventListener('click', (e) => {
  const row = e.target.closest('[data-usage-conv]');
  if (row) openConv(row.dataset.usageConv);
});

// --- Connexions : navigateur visible du serveur ---------------------------
//
// Ce n'est pas une iframe du site distant — Google et beaucoup d'autres la refuseraient.
// L'image vient d'un vrai Chromium sur Ubuntu ; clics et clavier lui sont renvoyes. Son
// profil est ensuite repris par le navigateur MCP des agents.

let remoteBrowser = null;
let remoteBrowserTimer = null;
let remoteBrowserFrameBusy = false;
let remoteBrowserActions = Promise.resolve();
let authRequests = [];
let selectedAuthRequestId = null;
let googleConnection = null;
const remoteBrowserHome = $('#remote-browser-shell').parentNode;
let googleOauthModalOpen = false;
let connectionModalMode = null;
let openingAuthRequestId = null;

function remoteBrowserError(message) {
  const box = $('#remote-browser-error');
  box.textContent = message || '';
  box.classList.toggle('hidden', !message);
}

function googleError(message) {
  const box = $('#google-error');
  box.textContent = message || '';
  box.classList.toggle('hidden', !message);
}

function renderGoogle(google, forceSetup) {
  googleConnection = google || { config: { configured: false }, accounts: [] };
  const configured = Boolean(googleConnection.config && googleConnection.config.configured);
  const setup = Boolean(forceSetup) || !configured;
  $('#google-setup').classList.toggle('hidden', !setup);
  $('#google-ready').classList.toggle('hidden', setup || !configured);
  $('#google-callback').textContent = (googleConnection.config || {}).callbackUrl || '';
  $('#google-state').textContent = configured
    ? `${(googleConnection.accounts || []).length} compte(s) connecte(s)`
    : 'Non configure';
  $('#google-state').classList.toggle('on', configured && (googleConnection.accounts || []).length > 0);
  if (configured) {
    $('#google-client-id').value = googleConnection.config.clientId || '';
    const selected = new Set(googleConnection.config.groups || []);
    for (const input of document.querySelectorAll('.google-scopes input')) {
      input.checked = selected.has(input.value);
    }
  }
  $('#google-accounts').innerHTML = (googleConnection.accounts || []).length
    ? googleConnection.accounts.map((account) => `<div class="google-account">
        ${account.picture ? `<img src="${esc(account.picture)}" alt="">` : ''}
        <div><strong>${esc(account.name)}</strong><span>${esc(account.email)} · ${esc((account.groups || []).join(', '))}</span></div>
        <button class="ghost" data-google-remove="${esc(account.id)}" title="Deconnecter"><svg class="icon"><use href="#i-trash"/></svg></button>
      </div>`).join('')
    : '<div class="empty">Aucun compte Google connecte.</div>';
}

function renderRemoteBrowser(browser) {
  remoteBrowser = browser || { running: false };
  const running = Boolean(remoteBrowser.running);
  $('#remote-browser-start').classList.toggle('hidden', running);
  $('#remote-browser-shell').classList.toggle('hidden', !running);
  $('#remote-browser-state').textContent = running ? 'Ouvert sur Ubuntu' : 'Ferme';
  $('#remote-browser-state').classList.toggle('on', running);
  if (running) {
    $('#remote-browser-address').value = remoteBrowser.url || '';
    startRemoteBrowserFrames();
  } else {
    stopRemoteBrowserFrames();
    $('#remote-browser-frame').removeAttribute('src');
    if (googleOauthModalOpen) closeGoogleOauthModal(false);
  }
}

function openGoogleOauthModal(options) {
  const opts = options || {};
  googleOauthModalOpen = true;
  connectionModalMode = opts.mode || 'google';
  $('#connection-modal-title').textContent = opts.title || 'Connecter un compte Google';
  $('#connection-modal-reason').textContent =
    opts.reason || 'Cette fenetre est le navigateur Ubuntu. La session reste sur le serveur.';
  $('#connection-modal-foot').classList.toggle('hidden', connectionModalMode !== 'request');
  $('#google-oauth-browser').append($('#remote-browser-shell'));
  $('#google-oauth-modal').classList.remove('hidden');
  $('#remote-browser-screen').focus();
}

async function closeGoogleOauthModal(closeBrowser, completeRequest) {
  const wasRequest = connectionModalMode === 'request';
  googleOauthModalOpen = false;
  connectionModalMode = null;
  openingAuthRequestId = null;
  $('#google-oauth-modal').classList.add('hidden');
  remoteBrowserHome.insertBefore($('#remote-browser-shell'), $('#remote-browser-error'));
  if (closeBrowser && remoteBrowser && remoteBrowser.running) {
    try {
      const complete = wasRequest && completeRequest ? '1' : '0';
      const data = await api('DELETE', `/api/connections/browser?complete=${complete}`);
      renderRemoteBrowser(data.browser);
    } catch (err) {
      googleError(err.message);
    }
  }
}

async function openAuthRequestModal(request) {
  if (!request || openingAuthRequestId === request.id) return;
  openingAuthRequestId = request.id;
  remoteBrowserError('');
  try {
    const data = await api('POST', '/api/connections/browser', {
      url: request.url,
      requestId: request.id,
    });
    renderRemoteBrowser(data.browser);
    openGoogleOauthModal({
      mode: 'request',
      title: `Connexion requise — ${request.service}`,
      reason: request.reason,
    });
  } catch (err) {
    openingAuthRequestId = null;
    // Le profil peut etre occupe par un agent. La demande reste dans Connexions et rien
    // n'est perdu ; on affiche la raison au lieu de faire disparaitre l'evenement.
    remoteBrowserError(err.message);
    showConnections();
  }
}

function renderAuthRequests(rows) {
  authRequests = rows || [];
  const box = $('#auth-requests');
  box.classList.toggle('hidden', !authRequests.length);
  box.innerHTML = authRequests
    .map((r) => `<div class="auth-request">
      <svg class="icon"><use href="#i-key"/></svg>
      <div><strong>${esc(r.service)} demande une connexion</strong><p>${esc(r.reason)}</p></div>
      <button class="primary" data-auth-open="${esc(r.id)}">Se connecter</button>
    </div>`)
    .join('');
}

async function loadConnections() {
  remoteBrowserError('');
  googleError('');
  try {
    const [data, google] = await Promise.all([
      api('GET', '/api/connections/browser'),
      api('GET', '/api/connections/google'),
    ]);
    renderRemoteBrowser(data.browser);
    renderAuthRequests(data.requests);
    renderGoogle(google.google);
  } catch (err) {
    remoteBrowserError(err.message);
  }
}

function showConnections() {
  showView('#connections-view');
  state.currentId = null;
  renderList();
  loadConnections();
}

async function refreshRemoteBrowserFrame() {
  if (!remoteBrowser || !remoteBrowser.running || remoteBrowserFrameBusy) return;
  remoteBrowserFrameBusy = true;
  const img = $('#remote-browser-frame');
  const loading = $('#remote-browser-loading');
  const next = new Image();
  next.onload = () => {
    img.src = next.src;
    loading.classList.add('hidden');
    remoteBrowserFrameBusy = false;
  };
  next.onerror = () => {
    remoteBrowserFrameBusy = false;
  };
  next.src = `/api/connections/browser/frame?t=${Date.now()}`;
}

function startRemoteBrowserFrames() {
  if (remoteBrowserTimer) return;
  $('#remote-browser-loading').classList.remove('hidden');
  refreshRemoteBrowserFrame();
  remoteBrowserTimer = setInterval(refreshRemoteBrowserFrame, 650);
}

function stopRemoteBrowserFrames() {
  if (remoteBrowserTimer) clearInterval(remoteBrowserTimer);
  remoteBrowserTimer = null;
  remoteBrowserFrameBusy = false;
}

async function runRemoteBrowserAction(action, fields) {
  const data = await api('POST', '/api/connections/browser/action', { action, ...(fields || {}) });
  if (data.browser) {
    remoteBrowser = data.browser;
    $('#remote-browser-address').value = data.browser.url || '';
  }
  refreshRemoteBrowserFrame();
  return data.browser;
}

/** Clics et surtout caracteres doivent arriver dans le meme ordre que sur le clavier. */
function remoteBrowserAction(action, fields) {
  const next = remoteBrowserActions.then(() => runRemoteBrowserAction(action, fields));
  // Une action ratee ne condamne pas toutes les suivantes de la chaine.
  remoteBrowserActions = next.catch(() => {});
  return next;
}

$('#btn-connections').addEventListener('click', () => {
  showConnections();
  closeNav();
});
$('#btn-connections-back').addEventListener('click', openNav);
$('#btn-connections-refresh').addEventListener('click', loadConnections);

$('#btn-google-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#google-callback').textContent);
    $('#btn-google-copy').textContent = 'Copie';
    setTimeout(() => { $('#btn-google-copy').textContent = 'Copier'; }, 1500);
  } catch {
    googleError("Impossible de copier automatiquement : selectionne l'adresse.");
  }
});

$('#btn-google-config').addEventListener('click', async () => {
  googleError('');
  try {
    const groups = [...document.querySelectorAll('.google-scopes input:checked')].map((el) => el.value);
    const data = await api('POST', '/api/connections/google/config', {
      clientId: $('#google-client-id').value,
      clientSecret: $('#google-client-secret').value,
      groups,
    });
    $('#google-client-secret').value = '';
    renderGoogle(data.google);
  } catch (err) {
    googleError(err.message);
  }
});

$('#btn-google-settings').addEventListener('click', () => renderGoogle(googleConnection, true));

$('#btn-google-connect').addEventListener('click', async () => {
  googleError('');
  try {
    const flow = await api('POST', '/api/connections/google/start');
    const data = await api('POST', '/api/connections/browser', { url: flow.url });
    renderRemoteBrowser(data.browser);
    openGoogleOauthModal();
  } catch (err) {
    googleError(err.message);
  }
});

$('#btn-google-oauth-cancel').addEventListener('click', () => closeGoogleOauthModal(true, false));
$('#btn-connection-modal-cancel').addEventListener('click', () => closeGoogleOauthModal(true, false));
$('#btn-connection-modal-done').addEventListener('click', async () => {
  await closeGoogleOauthModal(true, true);
  loadConnections();
});
$('#google-oauth-modal').addEventListener('click', (e) => {
  if (e.target.id === 'google-oauth-modal') closeGoogleOauthModal(true, false);
});

$('#btn-google-browser').addEventListener('click', () => {
  selectedAuthRequestId = null;
  $('#remote-browser-url').value = 'https://accounts.google.com/';
  $('#btn-remote-browser-open').click();
});

$('#google-accounts').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-google-remove]');
  if (!button) return;
  const id = button.dataset.googleRemove;
  undoToast({
    message: 'Compte Google déconnecté d’agentHub',
    hide: button.closest('.google-account'),
    run: async () => {
      try {
        const data = await api('DELETE', `/api/connections/google/${encodeURIComponent(id)}`);
        renderGoogle(data.google);
      } catch (err) {
        googleError(err.message);
        throw err;
      }
    },
  });
});

$('#btn-remote-browser-open').addEventListener('click', async () => {
  remoteBrowserError('');
  try {
    const data = await api('POST', '/api/connections/browser', {
      url: $('#remote-browser-url').value,
      requestId: selectedAuthRequestId,
    });
    renderRemoteBrowser(data.browser);
    $('#remote-browser-screen').focus();
  } catch (err) {
    remoteBrowserError(err.message);
  }
});

$('#auth-requests').addEventListener('click', (e) => {
  const button = e.target.closest('[data-auth-open]');
  if (!button) return;
  const request = authRequests.find((r) => r.id === button.dataset.authOpen);
  if (!request) return;
  selectedAuthRequestId = request.id;
  $('#remote-browser-url').value = request.url;
  $('#btn-remote-browser-open').click();
});

async function navigateRemoteBrowser() {
  remoteBrowserError('');
  try {
    await remoteBrowserAction('navigate', { url: $('#remote-browser-address').value });
  } catch (err) {
    remoteBrowserError(err.message);
  }
}

$('#btn-remote-browser-go').addEventListener('click', navigateRemoteBrowser);
$('#remote-browser-address').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigateRemoteBrowser();
});
$('#btn-remote-browser-back').addEventListener('click', () =>
  remoteBrowserAction('key', { key: 'Alt+ArrowLeft' }).catch((err) => remoteBrowserError(err.message))
);

$('#btn-remote-browser-close').addEventListener('click', async () => {
  remoteBrowserError('');
  try {
    const data = await api('DELETE', '/api/connections/browser');
    renderRemoteBrowser(data.browser);
    selectedAuthRequestId = null;
    await loadConnections();
  } catch (err) {
    remoteBrowserError(err.message);
  }
});

$('#remote-browser-screen').addEventListener('click', (e) => {
  if (!remoteBrowser || !remoteBrowser.running) return;
  const rect = $('#remote-browser-frame').getBoundingClientRect();
  const viewport = remoteBrowser.viewport || { width: 1280, height: 800 };
  const x = ((e.clientX - rect.left) / rect.width) * viewport.width;
  const y = ((e.clientY - rect.top) / rect.height) * viewport.height;
  remoteBrowserAction('click', { x, y }).catch((err) => remoteBrowserError(err.message));
  $('#remote-browser-screen').focus();
});

const REMOTE_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft',
  'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
]);

$('#remote-browser-screen').addEventListener('keydown', (e) => {
  if (!remoteBrowser || !remoteBrowser.running) return;
  if (REMOTE_KEYS.has(e.key)) {
    e.preventDefault();
    remoteBrowserAction('key', { key: e.key }).catch((err) => remoteBrowserError(err.message));
  } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    remoteBrowserAction('type', { text: e.key }).catch((err) => remoteBrowserError(err.message));
  }
});

$('#remote-browser-screen').addEventListener('paste', (e) => {
  e.preventDefault();
  const text = e.clipboardData && e.clipboardData.getData('text/plain');
  if (text) remoteBrowserAction('type', { text }).catch((err) => remoteBrowserError(err.message));
});

$('#remote-browser-screen').addEventListener('wheel', (e) => {
  e.preventDefault();
  remoteBrowserAction('scroll', { deltaY: e.deltaY }).catch((err) => remoteBrowserError(err.message));
}, { passive: false });

// --- Déclencheurs ---------------------------------------------------------
//
// Un déclencheur lance un agent à heure fixe sur un dossier. La vue sert autant à en
// créer qu'à surveiller ce qu'ils coûtent : un horaire mal réglé se voit d'abord sur la
// facture.

const TRIGGER_STATUS = {
  working: 'en cours',
  done: 'terminée',
  error: 'en erreur',
  stopped: 'interrompue',
};

function trProvider() {
  const active = $('#tr-provider-pick').querySelector('.pick-btn.active');
  return active ? active.dataset.provider : 'claude';
}

function money(value) {
  if (!value) return '—';
  return value < 0.01 ? `${(value * 100).toFixed(2)} ¢` : `${value.toFixed(2)} $`;
}

function whenLabel(iso) {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const today = new Date();
  const sameDay = at.toDateString() === today.toDateString();
  const time = at.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `aujourd'hui à ${time}`;
  return `${at.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} à ${time}`;
}

/** Durée lisible : les millisecondes n'intéressent personne, les heures si. */
function duration(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Une ligne d'historique. Cliquable tant que la conversation existe : passé
 * `purgeAfterDays` elle est supprimée, la ligne reste — c'est précisément pour survivre à
 * la purge que l'historique est tenu à part — mais elle ne mène plus nulle part.
 */
/** Issue de ce que le rapport a révélé — distincte de l'issue de l'exécution elle-même. */
const REPORT_STATUS = { ok: 'rien à signaler', attention: 'à regarder', echec: 'échec' };

function runRow(run) {
  const status = TRIGGER_STATUS[run.status] || run.status || '—';
  const tag = `<span class="tr-st tr-st-${esc(run.status || 'done')}">${esc(status)}</span>`;
  const body = `<span class="run-when">${esc(whenLabel(run.startedAt))}</span>
    ${tag}
    <span class="run-dur">${esc(duration(run.durationMs))}</span>
    <span class="run-cost">${esc(money(run.costUsd))}</span>`;
  const title = run.error ? ` title="${esc(run.error.slice(0, 300))}"` : '';

  const line = run.gone
    ? `<div class="run-row gone"${title}>${body}<span class="run-gone">purgée</span></div>`
    : `<button class="run-row" data-run-conv="${esc(run.convId)}"${title}>${body}</button>`;

  // Le rapport est gardé sur l'exécution et pas seulement dans le fil : il reste donc
  // lisible ici après la purge de la conversation, quand la ligne ne mène plus nulle part.
  if (!run.report) return line;
  return `${line}
    <details class="run-report rr-${esc(run.report.status || 'ok')}">
      <summary>${esc(run.report.subject)} <span class="rr-state">${esc(
    REPORT_STATUS[run.report.status] || run.report.status || ''
  )}</span></summary>
      <div class="rr-body">${md(run.report.body)}</div>
    </details>`;
}

/** Historique replié : on l'ouvre quand on se demande si ça tourne, pas à chaque coup d'œil. */
function runHistory(t) {
  const list = t.runs || [];
  if (!list.length) return '';
  const failed = list.filter((r) => r.status === 'error').length;
  const summary = failed
    ? `${list.length} dernière${list.length > 1 ? 's' : ''} exécution${list.length > 1 ? 's' : ''} · ${failed} en erreur`
    : `${list.length} dernière${list.length > 1 ? 's' : ''} exécution${list.length > 1 ? 's' : ''}`;

  return `<details class="run-history${failed ? ' has-error' : ''}" data-run-history="${t.id}"${
    state.openRuns.has(t.id) ? ' open' : ''
  }>
    <summary>${esc(summary)}</summary>
    <div class="run-rows">${list.map(runRow).join('')}</div>
  </details>`;
}

function triggerCard(t) {
  const freq = (state.frequencies || []).find((f) => f.value === t.frequency);
  const weekdayNames = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
  const cadence = freq && freq.weekdays && Array.isArray(t.weekdays)
    ? t.weekdays.map((day) => weekdayNames[day]).join(', ')
    : freq ? freq.label : t.frequency;
  const once = Boolean(freq && freq.once);
  const hook = Boolean(freq && freq.hook);
  // Une exécution unique porte son instant, pas une heure de la journée.
  const at = once
    ? t.runAt
      ? ` — ${whenLabel(t.runAt)}`
      : ''
    : t.hour === null || t.hour === undefined
      ? ''
      : ` à ${String(t.hour).padStart(2, '0')} h`;
  // Un one-shot déjà parti n'a plus d'échéance : « désactivé » serait faux, il a fait son
  // travail. Modifier sa date le réarme.
  const spent = once && !t.nextRunAt;
  const u = t.usage || { costUsd: 0, avgCostUsd: 0, runs: 0 };

  return `<div class="trigger-card${t.enabled ? '' : ' off'}" data-trigger="${t.id}">
    <div class="trigger-top">
      ${providerIcon(t.provider)}
      <span class="trigger-name">${esc(t.name)}</span>
      <button class="ghost trigger-act" data-tr-run="${t.id}" title="Lancer maintenant"><svg class="icon"><use href="#i-play"/></svg></button>
      <button class="ghost trigger-act" data-tr-toggle="${t.id}" title="${t.enabled ? 'Désactiver' : 'Activer'}"><svg class="icon"><use href="#${t.enabled ? 'i-pause' : 'i-play'}"/></svg></button>
      <button class="ghost trigger-act danger-act" data-tr-delete="${t.id}" title="Supprimer le déclencheur"><svg class="icon"><use href="#i-trash"/></svg></button>
    </div>
    <div class="trigger-meta">${esc(cadence)}${esc(at)} · ${esc(t.model || 'modèle par défaut')} · <span class="trigger-path">${esc(t.cwd)}</span></div>
    ${
      hook && t.hookToken
        ? `<div class="hook-url" title="Le jeton est le seul secret : quiconque a cette URL lance l'agent.">
            <code data-hook-url>${esc(`${location.origin}/api/hooks/${t.hookToken}`)}</code>
            <button class="ghost trigger-act" data-tr-copy="${esc(t.hookToken)}" title="Copier l'URL"><svg class="icon"><use href="#i-copy"/></svg></button>
          </div>`
        : ''
    }
    <div class="trigger-stats">
      <div class="trigger-stat">
        <span class="ts-label">Prochaine</span>
        <span class="ts-value">${
          spent ? 'terminé' : t.enabled ? esc(whenLabel(t.nextRunAt)) : 'désactivé'
        }</span>
      </div>
      <div class="trigger-stat">
        <span class="ts-label">Dernière</span>
        <span class="ts-value">${
          t.lastRunAt
            ? `${esc(whenLabel(t.lastRunAt))} · <span class="tr-st tr-st-${esc(t.lastStatus || 'done')}">${esc(TRIGGER_STATUS[t.lastStatus] || t.lastStatus || '—')}</span>`
            : 'jamais'
        }</span>
      </div>
      <div class="trigger-stat">
        <span class="ts-label">Coût total</span>
        <span class="ts-value">${esc(money(u.costUsd))}</span>
      </div>
      <div class="trigger-stat">
        <span class="ts-label">Moyenne / exécution</span>
        <span class="ts-value">${esc(money(u.avgCostUsd))}${u.runs ? ` <span class="ts-runs">sur ${u.runs}</span>` : ''}</span>
      </div>
    </div>
    ${runHistory(t)}
  </div>`;
}

function renderTriggers(data) {
  state.frequencies = data.frequencies || state.frequencies || [];
  state.triggers = data.triggers || [];

  const active = state.triggers.filter((t) => t.enabled).length;
  const total = state.triggers.reduce((sum, t) => sum + ((t.usage && t.usage.costUsd) || 0), 0);
  $('#triggers-sub').textContent = state.triggers.length
    ? `${state.triggers.length} déclencheur${state.triggers.length > 1 ? 's' : ''}, ${active} actif${active > 1 ? 's' : ''} · ${money(total) === '—' ? 'aucun coût' : `${money(total)} au total`}`
    : 'Aucun déclencheur';

  $('#triggers-list').innerHTML = state.triggers.length
    ? state.triggers.map(triggerCard).join('')
    : `<div class="empty">Rien de planifié. Un agent peut partir à heure fixe, ou une seule
        fois à un moment choisi, sans que tu sois devant l'écran.</div>`;
}

/**
 * Champs du rapport : masqués tant qu'il n'est pas demandé. Le champ mail est laissé
 * visible même sans SMTP configuré, avec la raison écrite dessous — sinon on cherche un
 * champ qui a disparu sans savoir pourquoi.
 */
function syncReportFields() {
  const wanted = $('#tr-report').checked;
  $('#tr-report-fields').classList.toggle('hidden', !wanted);
  const canMail = Boolean(state.mailReady);
  $('#tr-report-email').disabled = !canMail;
  $('#tr-report-mail-note').classList.toggle('hidden', canMail);
  if (!canMail) $('#tr-report-email').value = '';
}

$('#tr-report').addEventListener('change', syncReportFields);

/** Fréquence, heure, et la note qui explique ce sur quoi le déclencheur se cale. */
function syncTriggerForm() {
  const freq = (state.frequencies || []).find((f) => f.value === $('#tr-freq').value);
  const acceptsHour = Boolean(freq && freq.acceptsHour);
  const once = Boolean(freq && freq.once);
  const hook = Boolean(freq && freq.hook);
  const picksWeekdays = Boolean(freq && freq.weekdays);

  $('#tr-hour-field').classList.toggle('hidden', !acceptsHour);
  $('#tr-runat-field').classList.toggle('hidden', !once);
  $('#tr-hookmin-field').classList.toggle('hidden', !hook);
  $('#tr-weekdays-field').classList.toggle('hidden', !picksWeekdays);

  $('#tr-freq-note').textContent = hook
    ? "Aucune échéance : l'agent part quand on appelle son URL. Elle s'affiche sur la carte du déclencheur une fois créé, avec son jeton — c'est le seul secret, ne la publie pas."
    : once
    ? "Le turn part à cet instant, une fois, puis le déclencheur ne se réarme jamais. Heure du serveur, réglé sur le même fuseau que toi."
    : acceptsHour
      ? picksWeekdays
        ? "Le turn part uniquement les jours sélectionnés, à cette heure."
        : "L'heure est celle du serveur, réglé sur le même fuseau que toi."
      : freq
        ? `« ${freq.label} » se cale sur le moment de la création, il n'y a donc pas d'heure à choisir.`
        : '';

  // Pré-rempli à dans une heure, arrondi : personne ne planifie à la seconde, et un champ
  // vide oblige à tout saisir alors que la date du jour est presque toujours la bonne.
  if (once && !$('#tr-runat').value) {
    const at = new Date(Date.now() + 3_600_000);
    at.setMinutes(0, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    $('#tr-runat').value =
      `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
      `T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  }
}

function renderTriggerModels() {
  const provider = trProvider();
  $('#tr-model').innerHTML = modelOptionsHtml(provider);
  setEffortSelect($('#tr-effort'), provider, $('#tr-model').value, false);
}

async function showTriggers() {
  showView('#triggers-view');
  state.currentId = null;
  renderList();
  try {
    const data = await api('GET', '/api/triggers');
    if (!state.frequencies || !$('#tr-freq').options.length) {
      $('#tr-freq').innerHTML = (data.frequencies || []).filter((f) => f.selectable !== false)
        .map((f) => `<option value="${esc(f.value)}">${esc(f.label)}</option>`)
        .join('');
      $('#tr-hour').innerHTML = Array.from({ length: 24 }, (_, h) => {
        const label = `${String(h).padStart(2, '0')} h`;
        return `<option value="${h}"${h === 7 ? ' selected' : ''}>${label}</option>`;
      }).join('');
    }
    state.mailReady = Boolean(data.mailReady);
    renderTriggers(data);
    renderProviderPick('#tr-provider-pick', trProvider());
    renderTriggerModels();
    syncTriggerForm();
    syncReportFields();
    await loadTriggerProjects();
  } catch (err) {
    $('#triggers-list').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

/** Le sélecteur de dossier réutilise les groupes Pro/Perso du serveur. */
async function loadTriggerProjects() {
  if ($('#tr-project').options.length) return;
  const data = await api('GET', '/api/projects');
  const groups = (data.groups || [])
    .filter((g) => g.projects.length)
    .map(
      (g) =>
        `<optgroup label="${esc(g.label)}">${g.projects
          .map((p) => `<option value="${esc(p.path)}">${esc(p.name)}${p.git ? ' · git' : ''}</option>`)
          .join('')}</optgroup>`
    )
    .join('');
  $('#tr-project').innerHTML = `<option value="">Choisir un dossier…</option>${groups}`;
}

$('#btn-triggers').addEventListener('click', () => {
  showTriggers();
  closeNav();
});
$('#btn-triggers-refresh').addEventListener('click', () => showTriggers());
$('#btn-triggers-back').addEventListener('click', () => document.body.classList.add('nav-open'));
$('#tr-freq').addEventListener('change', syncTriggerForm);

$('#tr-model').addEventListener('change', () => {
  setEffortSelect($('#tr-effort'), trProvider(), $('#tr-model').value, true);
});

$('#tr-provider-pick').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-provider]');
  if (!btn) return;
  for (const other of $('#tr-provider-pick').querySelectorAll('.pick-btn')) {
    other.classList.toggle('active', other === btn);
  }
  renderTriggerModels();
});

$('#btn-tr-create').addEventListener('click', async () => {
  const err = $('#tr-error');
  err.textContent = '';
  const body = {
    name: $('#tr-name').value.trim(),
    provider: trProvider(),
    cwd: $('#tr-project').value,
    model: $('#tr-model').value || null,
    effort: $('#tr-effort').value || null,
    frequency: $('#tr-freq').value,
    prompt: $('#tr-prompt').value.trim(),
    killAfterMinutes: $('#tr-kill').value ? Number($('#tr-kill').value) : null,
    purgeAfterDays: $('#tr-purge').value ? Number($('#tr-purge').value) : null,
    report: $('#tr-report').checked,
    reportSpec: $('#tr-report-spec').value.trim(),
    reportEmail: $('#tr-report').checked ? $('#tr-report-email').value.trim() : '',
  };
  // `datetime-local` rend « 2026-08-03T18:00 », sans fuseau : c'est bien de l'heure murale
  // qu'on veut, et le serveur tourne sur le même fuseau.
  const chosen = (state.frequencies || []).find((f) => f.value === body.frequency);
  if (chosen && chosen.once) body.runAt = $('#tr-runat').value;
  if (chosen && chosen.hook) body.hookMinIntervalSec = Number($('#tr-hookmin').value);
  // L'heure n'est envoyée que si la fréquence en accepte une : sinon le serveur refuse,
  // à juste titre.
  const freq = (state.frequencies || []).find((f) => f.value === body.frequency);
  if (freq && freq.acceptsHour) body.hour = Number($('#tr-hour').value);
  if (freq && freq.weekdays) {
    body.weekdays = [...document.querySelectorAll('.weekday-pick input:checked')].map((input) =>
      Number(input.value)
    );
  }

  if (!body.cwd) return void (err.textContent = 'Choisis un dossier de travail.');

  $('#btn-tr-create').disabled = true;
  try {
    await api('POST', '/api/triggers', body);
    $('#tr-name').value = '';
    $('#tr-prompt').value = '';
    $('#tr-report-spec').value = '';
    $('#trigger-form').open = false;
    await showTriggers();
    await refreshList();
  } catch (e2) {
    err.textContent = e2.message;
  } finally {
    $('#btn-tr-create').disabled = false;
  }
});

// `toggle` ne remonte pas : on l'écoute à la capture, sinon rien n'arrive jusqu'ici.
$('#triggers-list').addEventListener(
  'toggle',
  (e) => {
    const id = e.target.dataset && e.target.dataset.runHistory;
    if (!id) return;
    if (e.target.open) state.openRuns.add(id);
    else state.openRuns.delete(id);
  },
  true
);

$('#triggers-list').addEventListener('click', async (e) => {
  // Ouvrir une exécution passée. Traité avant le reste : c'est une navigation, elle ne
  // doit rien relancer ni recharger la vue.
  const past = e.target.closest('[data-run-conv]');
  if (past) {
    openConv(past.dataset.runConv);
    return;
  }

  // Copier l'URL du webhook. Elle est recopiée dans un service tiers, souvent depuis un
  // téléphone : la sélectionner à la main sur une ligne de code est le geste qu'on évite.
  const copy = e.target.closest('[data-tr-copy]');
  if (copy) {
    const url = `${location.origin}/api/hooks/${copy.dataset.trCopy}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("URL du webhook copiée");
    } catch {
      // `clipboard` demande un contexte sécurisé, et l'app est souvent servie en http :
      // le refus est le cas normal ici, pas l'exception. On sélectionne le texte pour que la
      // copie manuelle tienne en un raccourci.
      const code = copy.closest('.hook-url').querySelector('[data-hook-url]');
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      toast('Copie automatique refusée en http — URL sélectionnée');
    }
    return;
  }

  const run = e.target.closest('[data-tr-run]');
  const toggle = e.target.closest('[data-tr-toggle]');
  const del = e.target.closest('[data-tr-delete]');
  if (!run && !toggle && !del) return;

  try {
    if (run) {
      const { conversation } = await api('POST', `/api/triggers/${run.dataset.trRun}/run`);
      await refreshList();
      openConv(conversation.id);
      return;
    }
    if (toggle) {
      const t = state.triggers.find((x) => x.id === toggle.dataset.trToggle);
      await api('PATCH', `/api/triggers/${toggle.dataset.trToggle}`, { enabled: !t.enabled });
    }
    if (del) {
      const t = state.triggers.find((x) => x.id === del.dataset.trDelete);
      return void undoToast({
        message: `« ${t ? t.name : 'Déclencheur'} » supprimé — ses exécutions passées restent`,
        hide: del.closest('.trigger-card'),
        run: async () => {
          await api('DELETE', `/api/triggers/${del.dataset.trDelete}`);
          await showTriggers();
        },
      });
    }
    await showTriggers();
  } catch (err) {
    $('#triggers-list').insertAdjacentHTML('afterbegin', `<div class="empty">${esc(err.message)}</div>`);
  }
});

/**
 * Recharge l'état des comptes et remet l'interface d'accord avec lui. `refresh` force le
 * serveur à réinterroger les CLIs au lieu de servir son cache — utile juste après une
 * connexion ou une déconnexion.
 */
async function refreshAccounts(refresh) {
  try {
    const data = await api('GET', `/api/accounts${refresh ? '?refresh=1' : ''}`);
    state.accounts = data.accounts;
  } catch {
    // Injoignable : on laisse `state.accounts` tel quel. Une interface qui masque tout
    // parce qu'une requête a échoué serait pire que le problème.
    return;
  }
  renderAccounts();
  renderFilters();
  renderNoProvider();
  const active = renderProviderPick('#provider-pick', state.provider);
  if (active && active !== state.provider) {
    state.provider = active;
    renderModels();
  }
  renderLimits();
}

async function refreshList() {
  const data = await api('GET', '/api/conversations');
  state.convs = data.conversations;
  if (data.folders) state.folders = data.folders;
  renderList();
}

// Rafraîchissement groupé, pour les événements qui arrivent en rafale.
//
// Un turn en émet des dizaines par seconde, et chacun déclenchait son propre GET sur
// `/api/conversations` — la même liste resservie plusieurs fois par seconde. Le rendu ne coûte
// plus rien maintenant qu'il est réconcilié, mais l'aller-retour réseau, si.
//
// Le premier appel d'une rafale arme le minuteur et les suivants s'y raccrochent : c'est donc
// le dernier état qui est affiché, pas le premier. L'effet immédiat que l'utilisateur attend
// — la pastille qui passe à l'ambre — est appliqué localement par celui qui reçoit l'événement,
// sans attendre ce rafraîchissement.
let listTimer = null;

function scheduleListRefresh() {
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    refreshList().catch(() => {});
  }, 150);
}

// --- Actions --------------------------------------------------------------

$('#provider-state').addEventListener('click', openAccountsModal);
$('#btn-connect').addEventListener('click', openAccountsModal);

$('#btn-recheck').addEventListener('click', async () => {
  const btn = $('#btn-recheck');
  btn.disabled = true;
  btn.textContent = 'vérification…';
  await refreshAccounts(true);
  btn.disabled = false;
  btn.textContent = 'vérifie à nouveau';
});

$('#btn-new').addEventListener('click', () => {
  showNew();
  closeNav();
});
function openNav() {
  document.body.classList.add('nav-open');
}
function closeNav() {
  document.body.classList.remove('nav-open');
}

$('#btn-burger').addEventListener('click', closeNav);
$('#backdrop').addEventListener('click', closeNav);
$('#btn-back').addEventListener('click', openNav);
$('#btn-nav-new').addEventListener('click', openNav);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('nav-open')) closeNav();
});

$('#provider-pick').addEventListener('click', (e) => {
  const btn = e.target.closest('.pick-btn');
  if (!btn) return;
  state.provider = btn.dataset.provider;
  // Limité au conteneur : `document.querySelectorAll` attrapait aussi les boutons du
  // formulaire de déclencheur, dont la sélection changeait sans qu'on y touche.
  $('#provider-pick')
    .querySelectorAll('.pick-btn')
    .forEach((b) => b.classList.toggle('active', b === btn));
  renderModels();
  renderLimits();
});

/**
 * N'offre que les fournisseurs utilisables, et renvoie celui qui est finalement actif —
 * il peut différer de celui demandé si ce dernier n'est plus connecté.
 */
function renderProviderPick(selector, current) {
  const usable = usableProviders();
  const active = usable.includes(current) ? current : usable[0] || null;
  for (const btn of $(selector).querySelectorAll('.pick-btn')) {
    const p = btn.dataset.provider;
    btn.classList.toggle('hidden', !usable.includes(p));
    btn.classList.toggle('active', p === active);
  }
  return active;
}

/** Rien à proposer : on le dit une fois, au lieu d'afficher un formulaire inutilisable. */
function renderNoProvider() {
  const none = !usableProviders().length && state.accounts;
  $('#no-provider').classList.toggle('hidden', !none);
  $('#new-form').classList.toggle('hidden', Boolean(none));
  if (!none) return;

  const lines = ALL_PROVIDERS.map((p) => {
    const s = providerStatus(p) || {};
    const what = s.state === 'absent' ? 'pas installé' : 'installé, aucune session';
    return `<li><strong>${esc(PROVIDER_LABELS[p] || p)}</strong> — ${esc(what)}</li>`;
  }).join('');
  $('#no-provider-list').innerHTML = lines;
}

// --- Connexion des fournisseurs ---------------------------------------------
//
// Le serveur lance la commande d'authentification du CLI et en extrait l'URL et le code ;
// on les affiche. Deux formes : Claude renvoie une URL et attend qu'on lui colle le code
// obtenu dans le navigateur, Codex et Grok affichent un code à confirmer et interrogent
// leur serveur tout seuls.

const LOGIN_STEP = {
  starting: 'Démarrage…',
  waiting: 'En attente de ton autorisation',
  done: 'Connecté',
  failed: 'Échec',
  cancelled: 'Annulé',
};

let loginProvider = null; // fournisseur dont la fenêtre de connexion est ouverte

function loginBody(provider, view) {
  const name = PROVIDER_LABELS[provider] || provider;

  if (view.state === 'done') {
    return `<div class="login-done"><svg class="icon"><use href="#i-check"/></svg>
      ${esc(name)} est connecté.</div>`;
  }
  if (view.state === 'failed' || view.state === 'cancelled') {
    return `<div class="modal-warn">${esc(view.error || 'Connexion annulée.')}</div>`;
  }
  if (!view.url) {
    return `<p>Démarrage de <strong>${esc(name)}</strong>…</p>`;
  }

  const codeBlock = view.code
    ? `<div class="login-step">
         <span class="login-num">2</span>
         <div>
           <p>Vérifie que le navigateur affiche bien ce code, puis confirme :</p>
           <div class="login-code">${esc(view.code)}</div>
         </div>
       </div>`
    : `<div class="login-step">
         <span class="login-num">2</span>
         <div>
           <p>Le navigateur te donnera un code. Colle-le ici :</p>
           <div class="login-paste">
             <input id="login-code" placeholder="code affiché par le navigateur" autocomplete="off">
             <button id="login-send" class="primary">Valider</button>
           </div>
         </div>
       </div>`;

  return `
    <div class="login-step">
      <span class="login-num">1</span>
      <div>
        <p>Ouvre ce lien et autorise l'accès :</p>
        <a class="login-url" href="${esc(view.url)}" target="_blank" rel="noopener">${esc(view.url)}</a>
      </div>
    </div>
    ${codeBlock}
    <div class="login-state">${esc(LOGIN_STEP[view.state] || view.state)}${
      view.codeSent ? ' · code envoyé' : ''
    }</div>
    <div id="modal-error" class="modal-warn hidden"></div>`;
}

function renderLoginModal(provider, view) {
  if (loginProvider !== provider) return;
  $('#modal-title').textContent = `Connecter ${PROVIDER_LABELS[provider] || provider}`;
  $('#modal-body').innerHTML = loginBody(provider, view);
  $('#modal-ok').classList.add('hidden');
  $('#modal-cancel').textContent = view.state === 'done' ? 'Fermer' : 'Annuler';

  const send = $('#login-send');
  if (!send) return;
  const submit = async () => {
    const code = $('#login-code').value.trim();
    if (!code) return;
    send.disabled = true;
    try {
      await api('POST', `/api/accounts/${provider}/login/code`, { code });
    } catch (err) {
      const slot = $('#modal-error');
      if (slot) {
        slot.textContent = err.message;
        slot.classList.remove('hidden');
      }
      send.disabled = false;
    }
  };
  send.addEventListener('click', submit);
  $('#login-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

async function startLogin(provider) {
  loginProvider = provider;
  openModal(`Connecter ${PROVIDER_LABELS[provider] || provider}`, '<p>Démarrage…</p>', '', null);
  try {
    const { login } = await api('POST', `/api/accounts/${provider}/login`);
    renderLoginModal(provider, login);
  } catch (err) {
    renderLoginModal(provider, { state: 'failed', error: err.message });
  }
}

function logoutProvider(provider, row) {
  const name = PROVIDER_LABELS[provider] || provider;
  undoToast({
    message: `${name} déconnecté — les conversations restent lisibles`,
    hide: row,
    run: async () => {
      try {
        await api('POST', `/api/accounts/${provider}/logout`);
      } catch (err) {
        throw new Error(`Déconnexion impossible : ${err.message}`);
      }
      await refreshAccounts(true);
      // Ne repeindre la fenêtre des comptes que si elle est encore ouverte : la
      // déconnexion part six secondes après le clic, l'utilisateur a pu la fermer.
      if (!$('#modal').classList.contains('hidden')) openAccountsModal();
    },
  });
}

/** Une seule place pour voir, connecter et déconnecter les comptes. */
function openAccountsModal() {
  const rows = ALL_PROVIDERS.map((p) => {
    const s = providerStatus(p) || { state: 'unknown' };
    const name = PROVIDER_LABELS[p] || p;
    const action =
      s.state === 'online'
        ? `<button class="secondary" data-logout="${p}">Déconnecter</button>`
        : s.state === 'absent'
          ? ''
          : `<button class="primary" data-login="${p}">Connecter</button>`;
    const detail =
      s.state === 'online'
        ? `${esc(s.account || '')}${s.label ? ` · ${esc(s.label)}` : ''}`
        : esc(s.label || s.state);
    return `<div class="acct-row">
      ${providerIcon(p)}
      <div class="acct-main">
        <div class="acct-name">${esc(name)}</div>
        <div class="acct-detail">${detail}</div>
      </div>
      ${action}
    </div>`;
  }).join('');

  openModal(
    'Comptes',
    `${rows}<p class="hint acct-hint">Un fournisseur absent doit d'abord être installé sur le
      serveur. Se déconnecter ne supprime aucune conversation.</p>`,
    '',
    null
  );

  $('#modal-body').addEventListener('click', (e) => {
    const inBtn = e.target.closest('[data-login]');
    const outBtn = e.target.closest('[data-logout]');
    if (inBtn) startLogin(inBtn.dataset.login);
    else if (outBtn) logoutProvider(outBtn.dataset.logout, outBtn.closest('.acct-row'));
  });
}

/** Le pied de la sidebar dit sous quels comptes on travaille, pas ce qui manque. */
function renderAccounts() {
  if (!state.accounts) return;
  const online = ALL_PROVIDERS.filter((p) => (providerStatus(p) || {}).state === 'online');

  $('#provider-state').innerHTML = online.length
    ? online
        .map((p) => {
          const s = providerStatus(p);
          const who = s.account || PROVIDER_LABELS[p] || p;
          return `<span class="acct" title="${esc(PROVIDER_LABELS[p] || p)}${
            s.label ? ` · ${esc(s.label)}` : ''
          }">${providerIcon(p)}${esc(who)}</span>`;
        })
        .join('')
    : '<span class="warn">Aucun agent connecté</span>';
}

// --- Sélecteurs dossier / modèle -----------------------------------------

const CUSTOM = '__custom__';
const NEW_FOLDER = '__new__';
/** Conversation sans projet : le serveur lui ouvre un dossier de travail à elle seule. */
const NO_PROJECT = '__none__';

async function loadProjects(selectPath) {
  const data = await api('GET', '/api/projects');
  state.newFolderParents = data.newFolderParents || [];
  // Quels dossiers sont versionnés : c'est ce qui décide d'offrir l'isolation ou non.
  state.gitProjects = new Set(
    data.groups.flatMap((g) => g.projects.filter((p) => p.git).map((p) => p.path))
  );

  const groups = data.groups
    .filter((g) => g.projects.length)
    .map(
      (g) =>
        `<optgroup label="${esc(g.label)}">${g.projects
          .map(
            (p) =>
              `<option value="${esc(p.path)}">${esc(p.name)}${p.git ? ' · git' : ''}</option>`
          )
          .join('')}</optgroup>`
    )
    .join('');

  $('#project').innerHTML =
    `<option value="">Choisir un dossier…</option>` +
    // « Sans projet » avant la liste : c'est le choix de qui veut juste parler à un agent,
    // et le faire chercher au fond d'un menu de projets serait à l'envers.
    `<option value="${NO_PROJECT}">Sans projet — dossier de travail à part</option>${groups}` +
    `<optgroup label="Autre"><option value="${NEW_FOLDER}">＋ Nouveau dossier sur le serveur…</option>` +
    `<option value="${CUSTOM}">Chemin libre…</option></optgroup>`;

  $('#new-folder-parent').innerHTML = state.newFolderParents
    .map((p) => `<option value="${esc(p)}">${esc(p)}/</option>`)
    .join('');

  if (selectPath) $('#project').value = selectPath;
  syncProjectField();
}

function syncProjectField() {
  const value = $('#project').value;
  $('#project-custom').classList.toggle('hidden', value !== CUSTOM);
  $('#new-folder').classList.toggle('hidden', value !== NEW_FOLDER);
  $('#project-none-note').classList.toggle('hidden', value !== NO_PROJECT);
  syncWorktreeField();
  if (value === CUSTOM) $('#project-custom').focus();
  if (value === NEW_FOLDER) $('#new-folder-name').focus();
}

/**
 * L'option n'a de sens que sur un dépôt git. Elle est proposée aussi sur un chemin libre,
 * dont on ne sait rien d'ici : le serveur refuse alors la création avec la vraie raison,
 * ce qui vaut mieux que de cacher une option qui aurait marché.
 */
function syncWorktreeField() {
  const value = $('#project').value;
  const known = state.gitProjects || new Set();
  const possible = value === CUSTOM || known.has(value);
  $('#new-worktree-field').classList.toggle('hidden', !possible);
  // Décochée en même temps que cachée : une case cochée invisible enverrait une demande
  // d'isolation que le serveur refuserait, sur un écran qui ne montre plus pourquoi.
  if (!possible) $('#new-worktree').checked = false;
  $('#new-worktree-note').textContent =
    "L'agent travaille dans une copie du dépôt, sur sa propre branche : deux conversations " +
    'sur le même projet ne se marchent plus dessus. Le travail se rapporte ensuite par le ' +
    "bouton « Fusionner » de l'en-tête. Sur un chemin libre, il faut un dépôt git ayant au " +
    'moins un commit.';
}

$('#project').addEventListener('change', syncProjectField);

function modelList(provider) {
  return (state.models && state.models[provider]) || [{ value: '', label: 'Défaut' }];
}

/**
 * Efforts du modèle choisi quand il en publie, sinon ceux du fournisseur.
 * `modelValue` null (saisie libre) retombe sur la liste du fournisseur.
 */
function effortList(provider, modelValue) {
  if (modelValue != null && modelValue !== CUSTOM) {
    const match = modelList(provider).find((model) => model.value === modelValue);
    if (match && Array.isArray(match.efforts) && match.efforts.length) return match.efforts;
  }
  const efforts = (state.models && state.models.efforts) || {};
  return efforts[provider] || [{ value: '', label: 'Défaut' }];
}

function effortOptionsHtml(provider, modelValue) {
  return effortList(provider, modelValue)
    .map((effort) => {
      const title = effort.title ? ` title="${escAttr(effort.title)}"` : '';
      return `<option value="${escAttr(effort.value)}"${title}>${esc(effort.label)}</option>`;
    })
    .join('');
}

function setEffortSelect(select, provider, modelValue, keep) {
  const previous = keep ? select.value : '';
  const list = effortList(provider, modelValue);
  select.innerHTML = effortOptionsHtml(provider, modelValue);
  select.value = list.some((effort) => effort.value === previous) ? previous : '';
}

function modelOptionHtml(model) {
  const title = model.title || model.note || '';
  const attr = title ? ` title="${escAttr(title)}"` : '';
  return `<option value="${escAttr(model.value)}"${attr}>${esc(model.label)}</option>`;
}

/** Options du menu Modèle. Un champ `group` ouvre un optgroup, dans l'ordre d'arrivée. */
function modelOptionsHtml(provider, { custom = false } = {}) {
  const groups = [];
  const loose = [];
  for (const model of modelList(provider)) {
    if (!model.group) {
      loose.push(model);
      continue;
    }
    let group = groups.find((item) => item.label === model.group);
    if (!group) {
      group = { label: model.group, items: [] };
      groups.push(group);
    }
    group.items.push(model);
  }
  return (
    loose.map(modelOptionHtml).join('') +
    groups
      .map(
        (group) =>
          `<optgroup label="${escAttr(group.label)}">${group.items.map(modelOptionHtml).join('')}</optgroup>`
      )
      .join('') +
    (custom ? `<option value="${CUSTOM}">Autre… (saisie libre)</option>` : '')
  );
}

function renderConvModel(conv) {
  const select = $('#conv-model');
  select.innerHTML = modelOptionsHtml(conv.provider);
  const value = conv.model || '';
  if (![...select.options].some((option) => option.value === value)) {
    const extra = document.createElement('option');
    extra.value = value;
    extra.textContent = value || 'Défaut';
    select.appendChild(extra);
  }
  select.value = value;
  const match = modelList(conv.provider).find((model) => model.value === value);
  select.title = (match && match.note) || 'Modèle de cette conversation, pour le prochain message';
}

function renderModels() {
  $('#model').innerHTML = modelOptionsHtml(state.provider, { custom: true });
  // L'option navigateur n'existe que là où elle est vraie : le service MCP doit être
  // configuré, et le fournisseur doit savoir recevoir une config MCP à l'appel. Décochée
  // en même temps que cachée, sinon un changement de fournisseur laisserait une case
  // cochée invisible qui ne ferait rien.
  const models = state.models || {};
  const browsable = (models.browsable || []).includes(state.provider);
  const always = (models.browserAlways || []).includes(state.provider);
  $('#new-browser-field').classList.toggle('hidden', !browsable && !always);
  $('#new-browser').disabled = always;
  $('#new-browser').checked = always;
  if (!browsable && !always) $('#new-browser').checked = false;
  $('#new-browser-note').textContent = always
    ? "Cet agent a le navigateur en permanence : il est inscrit dans sa configuration globale, hors de l'app."
    : "Il pourra ouvrir une page, cliquer, remplir un formulaire, lire la console et prendre des captures — y compris sur tes projets en local. Les captures apparaissent dans le fil.";
  syncModelField();
}

function syncModelField() {
  const custom = $('#model').value === CUSTOM;
  $('#model-custom').classList.toggle('hidden', !custom);
  if (custom) $('#model-custom').focus();
  const match = custom
    ? null
    : modelList(state.provider).find((model) => model.value === $('#model').value);
  const text = custom
    ? "N'importe quel identifiant que le CLI accepte."
    : (match && match.note) || '';
  const note = $('#model-note');
  note.textContent = text;
  note.classList.toggle('hidden', !text);
  setEffortSelect($('#effort'), state.provider, custom ? null : $('#model').value, true);
}

$('#model').addEventListener('change', syncModelField);

function currentCwd() {
  const value = $('#project').value;
  if (value === CUSTOM) return $('#project-custom').value.trim();
  if (value === NEW_FOLDER) return '';
  // « Sans projet » : pas de chemin, le serveur en ouvre un pour cette conversation seule.
  if (value === NO_PROJECT) return '';
  return value;
}

/** Un dossier choisi, ou l'absence assumée de dossier — les deux permettent de démarrer. */
function projectChosen() {
  return $('#project').value === NO_PROJECT || Boolean(currentCwd());
}

function currentModel() {
  const value = $('#model').value;
  if (value === CUSTOM) return $('#model-custom').value.trim() || null;
  return value || null;
}

$('#btn-mkdir').addEventListener('click', async () => {
  const name = $('#new-folder-name').value.trim();
  if (!name) return;
  try {
    const { project } = await api('POST', '/api/projects', {
      parent: $('#new-folder-parent').value,
      name,
    });
    $('#new-folder-name').value = '';
    await loadProjects(project.path);
    $('#new-error').textContent = '';
  } catch (err) {
    $('#new-error').textContent = err.message;
  }
});

$('#btn-create').addEventListener('click', async () => {
  const prompt = bullets.toMarkdown($('#new-prompt').value).trim();
  const cwd = currentCwd();
  // La consigne n'est plus obligatoire : sans elle, la conversation s'ouvre vide et le
  // premier message part du composeur, comme dans n'importe quelle discussion.
  if (!projectChosen()) {
    $('#new-error').textContent = 'Choisis un dossier de travail, ou « Sans projet ».';
    return;
  }
  $('#new-error').textContent = '';
  $('#btn-create').disabled = true;
  try {
    const data = await api('POST', '/api/conversations', {
      provider: state.provider,
      cwd,
      model: currentModel(),
      effort: $('#effort').value || null,
      browser: $('#new-browser').checked,
      worktree: $('#new-worktree').checked,
      prompt,
      // Sans consigne il n'y a pas d'objectif à ouvrir : le serveur l'ignore alors.
      goal: $('#new-goal').checked,
      rounds: Number($('#new-goal-rounds').value) || GOAL_ROUNDS_DEFAULT,
    });
    $('#new-prompt').value = '';
    await refreshList();
    await openConv(data.conversation.id);
  } catch (err) {
    $('#new-error').textContent = err.message;
  } finally {
    $('#btn-create').disabled = false;
  }
});

// --- Mode objectif ---------------------------------------------------------
//
// Deux états qu'il ne faut pas confondre. Le mode **armé** : on s'apprête à écrire un objectif,
// rien n'est encore lancé — il vit dans le navigateur et disparaît au rechargement. L'objectif
// **en cours** : la boucle tourne côté serveur — il vit sur la conversation, donc il survit à
// un redémarrage, se voit depuis un autre appareil, et n'est jamais deviné d'ici.
//
// Les plafonds sont recopiés du serveur, qui reste seul juge : une valeur qu'il ne connaît pas
// retombe sur son défaut. Personne ne décide depuis le navigateur combien de turns on dépense.

const GOAL_ROUNDS = [3, 6, 12, 25];
const GOAL_ROUNDS_DEFAULT = 6;

let goalArmed = false;

function fillGoalRounds() {
  const options = GOAL_ROUNDS.map(
    (n) => `<option value="${n}"${n === GOAL_ROUNDS_DEFAULT ? ' selected' : ''}>${n}</option>`
  ).join('');
  for (const sel of ['#goal-rounds', '#new-goal-rounds']) {
    if (!$(sel).options.length) $(sel).innerHTML = options;
  }
}

function armGoal(on) {
  goalArmed = Boolean(on) && !(state.current && state.current.goal);
  $('#btn-goal').classList.toggle('on', goalArmed);
  $('#btn-compose-more').classList.toggle('on', goalArmed);
  $('#goal-arm').classList.toggle('hidden', !goalArmed);
  $('#prompt').placeholder = goalArmed
    ? 'Décris l’objectif à atteindre…'
    : 'Écris à l’agent…';
  if (goalArmed) $('#prompt').focus();
}

/** Bandeau de l'objectif en cours. Rien à afficher quand il n'y en a pas. */
function renderGoalLive() {
  const goal = state.current && state.current.goal;
  const box = $('#goal-live');
  box.classList.toggle('hidden', !goal);
  $('#btn-goal').classList.toggle('live', Boolean(goal));
  $('#btn-compose-more').classList.toggle('live', Boolean(goal));
  if (!goal) return;
  // Un objectif en cours prime sur le mode armé : on ne peut pas en ouvrir un second.
  if (goalArmed) armGoal(false);
  box.innerHTML = `<svg class="icon"><use href="#i-target"/></svg>
    <span class="goal-live-round">tour ${goal.round}/${goal.max}</span>
    <span class="goal-live-text">${esc(goal.text)}</span>
    <button id="btn-goal-abandon" class="ghost" title="Abandonner l’objectif — le turn en cours va jusqu’au bout">Abandonner</button>`;
}

/**
 * La question posée par l'agent, avec ses propositions et un champ libre.
 *
 * Les deux voies mènent au même endpoint : les boutons ne sont qu'un raccourci de saisie.
 * Le serveur ne valide pas la réponse contre les options — l'agent a proposé des choix, il
 * n'a pas imposé un menu, et « aucun des deux, fais plutôt X » doit rester possible.
 */
// --- Le signal dans l'onglet ------------------------------------------------
//
// Une question posée pendant qu'on travaille ailleurs se perd : l'onglet est en arrière-plan,
// le bandeau et la modale sont invisibles, et un agent attend pour rien. Le favicon et le
// titre sont les deux seules choses qu'un onglet montre quand on ne le regarde pas.

const FAVICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>🛰️</text></svg>";
// Même icône, plus une pastille ambre cerclée du fond de l'app : sans le cerclage elle se
// confond avec le dessin dès que l'onglet est réduit à 16 px.
const FAVICON_ASK = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>🛰️</text><circle cx='24' cy='8' r='7.5' fill='%23d9a15c' stroke='%231f1e1d' stroke-width='2.5'/></svg>";

const TITLE = 'agentHub';

/**
 * Favicon et titre selon les questions en attente, **toutes conversations confondues**.
 *
 * Se limiter à la conversation ouverte raterait le cas qui compte : une question posée par un
 * agent qu'on avait lancé puis quitté des yeux.
 */
function renderAskBadge() {
  const count = (state.pendingAsks || []).length;
  document.title = count ? `(${count}) ❓ ${TITLE}` : TITLE;
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.href = count ? FAVICON_ASK : FAVICON;
}

/** Questions écartées à la main, le temps de finir autre chose. Locales à cet onglet. */
const askDismissed = new Set();

/** Tient la liste des questions en attente à jour, d'où qu'arrive la nouvelle. */
function trackAsk(ask, gone) {
  const rows = (state.pendingAsks || []).filter((a) => a.id !== ask.id);
  if (!gone) rows.push(ask);
  else askDismissed.delete(ask.id);
  state.pendingAsks = rows;
  renderAskBadge();
  renderList(); // la pastille de la sidebar dit *laquelle* attend
  renderAskPending();
}

/**
 * Quelle question mettre à l'écran.
 *
 * Une question `live` passe devant tout, **même posée depuis une autre conversation** : un
 * agent y est suspendu et la fenêtre est de quatre minutes, obliger à la retrouver dans la
 * sidebar consommerait le peu de temps disponible. Celle de la conversation ouverte est
 * préférée quand il y en a plusieurs — c'est celle qu'on regardait.
 */
function askToShow() {
  const live = (state.pendingAsks || []).filter(
    (a) => a.mode === 'live' && !askDismissed.has(a.id)
  );
  return (
    live.find((a) => a.convId === state.currentId) ||
    live[0] ||
    (state.ask && !askDismissed.has(state.ask.id) ? state.ask : null)
  );
}

function askCardHtml(ask, live) {
  const options = (ask.options || [])
    .map((o) => `<button class="ask-option" data-ask-option="${escAttr(o)}">${esc(o)}</button>`)
    .join('');

  // Qui demande. Dit systématiquement en modale, où la question peut venir d'une autre
  // conversation que celle qu'on lit — sans ce nom, on ne sait pas à quoi on répond.
  const conv = state.convs.find((c) => c.id === ask.convId);
  const elsewhere = ask.convId !== state.currentId;
  const who = conv
    ? `<span class="ask-who">${providerIcon(conv.provider)}${esc(conv.title)}</span>`
    : '';

  // Ailleurs : de quoi y aller, et de quoi remettre à plus tard. La question posée sur la
  // conversation qu'on lit, elle, n'a pas de « plus tard » — on y est déjà.
  const nav = elsewhere
    ? `<div class="ask-nav">
         <button class="ask-goto" data-ask-goto="${escAttr(ask.convId)}">Ouvrir la conversation</button>
         <button class="ask-later" data-ask-later="${escAttr(ask.id)}">Plus tard</button>
       </div>`
    : '';

  return `<div class="ask-head">
      <svg class="icon"><use href="#i-ask"/></svg>
      <strong>${live ? 'L’agent attend ta réponse — il n’a pas coupé son travail' : 'L’agent attend ta réponse pour repartir'}</strong>
    </div>
    ${who}
    <p class="ask-question">${esc(ask.question)}</p>
    ${ask.context ? `<p class="ask-context">${esc(ask.context)}</p>` : ''}
    ${options ? `<div class="ask-options">${options}</div>` : ''}
    <div class="ask-free">
      <input class="ask-answer" type="text" autocomplete="off"
        placeholder="${options ? 'ou réponds autre chose…' : 'ta réponse…'}">
      <button class="primary ask-send">Répondre</button>
    </div>
    ${nav}
    <span class="ask-error error-text"></span>`;
}

/**
 * La question en attente, au bandeau ou en modale selon ce qui se passe derrière.
 *
 * `live` — un agent est suspendu à un appel d'outil : la modale s'impose, et elle n'a pas de
 * bouton pour fermer, parce que la fermer ne débloquerait rien. `turn` — le turn est déjà
 * fini, rien n'attend : un bandeau au-dessus du composeur suffit, et laisse écrire à côté.
 */
function renderAskPending() {
  const ask = askToShow();
  const live = Boolean(ask && ask.mode === 'live');
  const banner = $('#ask-pending');
  const modal = $('#ask-modal');

  banner.classList.toggle('hidden', !ask || live);
  modal.classList.toggle('hidden', !live);
  if (!ask) {
    banner.innerHTML = '';
    modal.firstElementChild.innerHTML = '';
    return;
  }

  const host = live ? modal.firstElementChild : banner;
  host.innerHTML = askCardHtml(ask, live);
  (live ? banner : modal.firstElementChild).innerHTML = '';
  const field = host.querySelector('.ask-answer');
  // Le focus est posé sur la modale seulement : le bandeau ne bloque rien, et voler le
  // curseur à qui est en train d'écrire dans le composeur serait pire que le service rendu.
  if (live && field) field.focus();
}

/**
 * Envoie la réponse. La carte disparaît quand le serveur confirme, pas avant.
 *
 * La question visée est celle affichée, qui n'est pas forcément celle de la conversation
 * ouverte : on répond par identifiant, donc depuis n'importe où.
 */
async function answerAsk(root, text) {
  const ask = askToShow();
  const answer = String(text || '').trim();
  const error = root.querySelector('.ask-error');
  if (!ask) return;
  if (!answer) {
    if (error) error.textContent = 'Écris une réponse.';
    return;
  }
  // Deux clics rapides sur la même option relanceraient deux turns si seul le serveur
  // arbitrait : il refuse la seconde réponse, mais autant ne pas la lui envoyer.
  const button = root.querySelector('.ask-send');
  if (button) button.disabled = true;
  if (error) error.textContent = '';
  try {
    await api('POST', `/api/asks/${ask.id}/answer`, { answer });
    if (state.ask && state.ask.id === ask.id) state.ask = null;
    // Le websocket confirmera, mais on ne l'attend pas : la carte doit tomber au clic.
    trackAsk(ask, true);
  } catch (err) {
    if (button) button.disabled = false;
    if (error) error.textContent = err.message;
  }
}

// Un seul écouteur pour les deux hôtes — bandeau et modale portent la même carte, et la
// dupliquer laisserait un jour l'un des deux sans son correctif.
document.addEventListener('click', (e) => {
  const root = e.target.closest('[data-ask-root]');
  if (!root) return;

  const goto = e.target.closest('[data-ask-goto]');
  if (goto) return openConv(goto.dataset.askGoto);

  // Écarté pour cet onglet seulement, et pas répondu : la pastille de la sidebar et le
  // badge de l'onglet restent, l'agent attend toujours.
  const later = e.target.closest('[data-ask-later]');
  if (later) {
    askDismissed.add(later.dataset.askLater);
    return renderAskPending();
  }

  const option = e.target.closest('[data-ask-option]');
  if (option) return answerAsk(root, option.dataset.askOption);
  if (e.target.closest('.ask-send')) answerAsk(root, root.querySelector('.ask-answer').value);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.classList.contains('ask-answer')) return;
  const root = e.target.closest('[data-ask-root]');
  if (!root) return;
  e.preventDefault();
  answerAsk(root, e.target.value);
});

$('#btn-goal').addEventListener('click', () => {
  if (state.current && state.current.goal) {
    // Déjà en boucle : le bouton sert alors à montrer le bandeau, pas à en armer un autre.
    $('#goal-live').scrollIntoView({ block: 'nearest' });
    return;
  }
  armGoal(!goalArmed);
});

$('#btn-compose-more').addEventListener('click', (e) => {
  e.stopPropagation();
  const opening = $('#compose-menu').classList.contains('hidden');
  closeMobileHeadMenu();
  $('#compose-menu').classList.toggle('hidden', !opening);
  $('#btn-compose-more').setAttribute('aria-expanded', String(opening));
});

$('#compose-menu').addEventListener('click', (e) => {
  const action = e.target.closest('[data-compose-action]');
  if (!action) return;
  e.stopPropagation();
  closeComposeMenu();
  if (action.dataset.composeAction === 'attach') {
    openAttachmentMenu($('#btn-compose-more'));
    return;
  }
  const target = {
    plan: '#btn-plan',
    goal: '#btn-goal',
    saved: '#btn-saved',
  }[action.dataset.composeAction];
  if (target) $(target).click();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#mobile-head-menu, #btn-head-more')) closeMobileHeadMenu();
  if (!e.target.closest('#compose-menu, #btn-compose-more')) closeComposeMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeMobileHeadMenu();
  closeComposeMenu();
});
$('#btn-goal-off').addEventListener('click', () => armGoal(false));
$('#goal-live').addEventListener('click', async (e) => {
  if (!e.target.closest('#btn-goal-abandon')) return;
  try {
    await api('DELETE', `/api/conversations/${state.currentId}/goal`);
  } catch (err) {
    toastError(err.message);
  }
});
$('#new-goal').addEventListener('change', () => {
  $('#new-goal-rounds-field').classList.toggle('hidden', !$('#new-goal').checked);
});

fillGoalRounds();

// --- Prompts enregistrés ---------------------------------------------------
//
// Les consignes qu'on retape toutes les semaines, avec des trous `{{nom}}`. Ce qu'on en fait,
// c'est **poser du texte dans le composeur**, jamais l'envoyer : on relit avant de lancer un
// agent, et c'est la différence avec une skill, qui est une procédure que le CLI déroule.

async function loadSavedPrompts() {
  try {
    state.prompts = (await api('GET', '/api/prompts')).prompts || [];
  } catch {
    state.prompts = [];
  }
  return state.prompts;
}

/** Remplit les trous d'un modèle. Rend le texte final, ou null si on renonce. */
async function fillPrompt(model) {
  if (!model.holes.length) return model.body;
  const inputs = new Map();
  const out = await openDialog({
    title: model.name,
    cancelValue: null,
    buildBody: (bodyEl) => {
      const note = document.createElement('p');
      note.className = 'dialog-p';
      note.textContent =
        'Un champ laissé vide garde son {{trou}} dans le texte : il se verra dans le composeur.';
      bodyEl.appendChild(note);
      for (const hole of model.holes) {
        const field = document.createElement('div');
        field.className = 'relay-field';
        const tag = document.createElement('label');
        tag.className = 'relay-label';
        tag.textContent = hole;
        const input = document.createElement('input');
        input.type = 'text';
        field.append(tag, input);
        bodyEl.appendChild(field);
        inputs.set(hole, input);
      }
    },
    buttons: [
      { label: 'Annuler', value: null },
      { label: 'Insérer', value: true, primary: true },
    ],
    focus: (root) => root.querySelector('.relay-field input'),
  });
  if (!out) return null;
  const values = {};
  for (const [hole, input] of inputs) values[hole] = input.value;
  // Le remplacement se fait côté navigateur, sur la même syntaxe que le serveur : demander au
  // serveur de remplir trois mots ferait un aller-retour pour rien.
  return model.body.replace(/\{\{\s*([^{}]{1,60}?)\s*\}\}/g, (whole, raw) => {
    const value = values[raw.trim()];
    return value === undefined || String(value).trim() === '' ? whole : String(value);
  });
}

/**
 * Le tiroir des modèles. `box` est le champ où le texte atterrit — le composeur d'une
 * conversation, ou celui de l'écran de création.
 */
async function openSavedPrompts(box) {
  await loadSavedPrompts();

  let picked = null;
  const decision = await openDialog({
    title: 'Prompts enregistrés',
    cancelValue: null,
    buildBody: (bodyEl) => {
      const list = document.createElement('div');
      list.className = 'saved-list';
      list.innerHTML = state.prompts.length
        ? state.prompts
            .map(
              (p) => `<div class="saved-row" data-saved="${esc(p.id)}">
                <button type="button" class="saved-pick">
                  <span class="saved-name">${esc(p.name)}</span>
                  <span class="saved-body">${esc(p.body.replace(/\s+/g, ' ').slice(0, 110))}</span>
                  ${p.holes.length ? `<span class="saved-holes">${p.holes.map((h) => esc(h)).join(' · ')}</span>` : ''}
                </button>
                <button type="button" class="ghost saved-act" data-saved-edit="${esc(p.id)}" title="Renommer"><svg class="icon"><use href="#i-pencil"/></svg></button>
                <button type="button" class="ghost saved-act danger-act" data-saved-del="${esc(p.id)}" title="Supprimer"><svg class="icon"><use href="#i-trash"/></svg></button>
              </div>`
            )
            .join('')
        : `<div class="empty">Aucun modèle. Écris une consigne dans le composeur, puis
            « Enregistrer le texte du composeur » : les trous s'écrivent <code>{{nom}}</code>.</div>`;
      bodyEl.appendChild(list);

      list.addEventListener('click', async (e) => {
        const del = e.target.closest('[data-saved-del]');
        const edit = e.target.closest('[data-saved-edit]');
        const pick = e.target.closest('.saved-pick');
        if (del) {
          await api('DELETE', `/api/prompts/${del.dataset.savedDel}`);
          del.closest('.saved-row').remove();
          return;
        }
        if (edit) {
          const model = state.prompts.find((p) => p.id === edit.dataset.savedEdit);
          const name = await askInput({ title: 'Renommer', label: 'Nom', value: model.name });
          if (!name) return;
          await api('PATCH', `/api/prompts/${model.id}`, { name });
          edit.closest('.saved-row').querySelector('.saved-name').textContent = name;
          return;
        }
        if (pick) {
          picked = pick.closest('[data-saved]').dataset.saved;
          // La modale ne se ferme que par ses boutons de pied : cliquer une ligne actionne
          // donc « Insérer », qui rend la main avec le choix.
          bodyEl.closest('.dialog-modal').querySelector('.modal-ok').click();
        }
      });
    },
    buttons: [
      { label: 'Fermer', value: null },
      { label: 'Enregistrer le texte du composeur', value: 'save' },
      // C'est ce bouton que le clic sur une ligne actionne : le corps d'une modale ne sait pas
      // la clore lui-même. Il reste visible, et sert de validation au clavier.
      { label: 'Insérer', value: 'pick', primary: true },
    ],
  });

  if (decision === 'save') {
    const body = box.value.trim();
    if (!body) return toastError('Le composeur est vide : rien à enregistrer.');
    const name = await askInput({
      title: 'Enregistrer ce prompt',
      label: 'Nom du modèle',
      placeholder: 'Revue de branche',
    });
    if (!name) return;
    await api('POST', '/api/prompts', { name, body });
    toast('Modèle enregistré');
    return;
  }

  if (decision !== 'pick' || !picked) return;
  const model = state.prompts.find((p) => p.id === picked);
  if (!model) return;
  const text = await fillPrompt(model);
  if (text === null) return;
  // Ajouté à la suite plutôt qu'en remplacement : un composeur déjà rempli contient du travail.
  box.value = box.value.trim() ? `${box.value.replace(/\s+$/, '')}\n\n${text}` : text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
  api('POST', `/api/prompts/${model.id}/used`).catch(() => {});
}

$('#btn-saved').addEventListener('click', () => openSavedPrompts($('#prompt')));
$('#btn-saved-new').addEventListener('click', () => openSavedPrompts($('#new-prompt')));

async function send() {
  if (!state.currentId) return;
  const box = $('#prompt');
  const ready = pendingImages.filter((img) => img.dataUrl);

  if (pendingImages.length !== ready.length) {
    renderAttachments('Lecture des pièces jointes en cours, réessaie dans un instant.');
    return;
  }

  // Une image seule est un message valide : on fournit la consigne implicite. Les puces
  // redeviennent des tirets ici : elles n'existent que pour la lecture pendant la frappe.
  const text = bullets.toMarkdown(box.value).trim() || (ready.length ? attachmentFallback(ready) : '');
  if (!text) return;

  const images = ready.map(({ name, dataUrl }) => ({ name, dataUrl }));
  const asGoal = goalArmed;
  box.value = '';
  autosizePrompt();
  clearAttachments();

  try {
    if (asGoal) {
      await api('POST', `/api/conversations/${state.currentId}/goal`, {
        objective: text,
        images,
        rounds: Number($('#goal-rounds').value) || GOAL_ROUNDS_DEFAULT,
      });
      armGoal(false);
    } else {
      await api('POST', `/api/conversations/${state.currentId}/messages`, { prompt: text, images });
    }
  } catch (err) {
    // Message perdu si on ne le rend pas : on le remet dans le champ.
    box.value = text;
    autosizePrompt();
    toastError(err.message);
  }
}

$('#btn-send').addEventListener('click', send);
$('#btn-stop').addEventListener('click', async () => {
  try {
    await api('POST', `/api/conversations/${state.currentId}/stop`);
  } catch (err) {
    toastError(err.message);
  }
});

// --- Vue Skills ------------------------------------------------------------
//
// Deux sources, deux questions différentes. L'inventaire dit ce qui est **sur disque**, donc
// ce qu'on peut déplacer ou supprimer. Le catalogue dit ce qu'un CLI **accepte**, plugins
// compris — celles-là ne sont pas déplaçables, elles appartiennent au plugin qui les
// remplacera à sa prochaine mise à jour. Les montrer quand même donne l'image complète.

const SCOPE_LABEL = { global: 'globale', project: 'projet' };

function skillRow(s) {
  const other = s.scope === 'global' ? 'project' : 'global';
  const move = `<button class="ghost" data-skill-move="${esc(s.name)}" data-from="${s.scope}" data-to="${other}"
      title="Déplacer en portée ${SCOPE_LABEL[other]}"><svg class="icon"><use href="#i-arrow-right"/></svg></button>`;
  return `<div class="skill-row${s.shadowed ? ' shadowed' : ''}">
    <code class="skill-row-name">/${esc(s.name)}</code>
    <span class="skill-scope sc-${s.scope}">${SCOPE_LABEL[s.scope]}</span>
    <span class="skill-row-desc">${esc(s.description || '')}</span>
    ${s.shadowed ? '<span class="skill-shadow" title="Une skill du projet porte le même nom et prime">masquée</span>' : move}
    <button class="ghost danger-act" data-skill-del="${esc(s.name)}" data-scope="${s.scope}"
      title="Supprimer"><svg class="icon"><use href="#i-trash"/></svg></button>
  </div>`;
}

function renderSkillsView(inv, catalogue) {
  const list = $('#skills-list');
  const mine = inv.skills || [];
  // Une skill de plugin n'est pas dans les deux dossiers : elle vient d'ailleurs.
  const onDisk = new Set(mine.map((s) => s.name));
  const fromPlugins = (catalogue || []).filter((s) => s.group && !onDisk.has(s.name));

  const sections = [];
  if (mine.length) {
    sections.push(
      `<div class="skills-section-head">À toi — ${mine.length} skill${mine.length > 1 ? 's' : ''}</div>` +
        mine.map(skillRow).join('')
    );
  } else {
    sections.push('<div class="empty">Aucune skill à toi pour l’instant.</div>');
  }

  if (fromPlugins.length) {
    const byGroup = new Map();
    for (const s of fromPlugins) {
      if (!byGroup.has(s.group)) byGroup.set(s.group, []);
      byGroup.get(s.group).push(s);
    }
    for (const [group, items] of byGroup) {
      sections.push(
        `<details class="skills-plugin">
          <summary>${esc(group)} — ${items.length} skill${items.length > 1 ? 's' : ''}, fournies par un plugin</summary>
          ${items
            .map(
              (s) => `<div class="skill-row read-only">
                <code class="skill-row-name">/${esc(s.name)}</code>
                <span class="skill-scope sc-plugin">plugin</span>
                <span class="skill-row-desc">${esc(s.description || '')}</span>
              </div>`
            )
            .join('')}
        </details>`
      );
    }
  }

  list.innerHTML = sections.join('');
  $('#skills-sub').textContent = `${mine.length} à toi · ${fromPlugins.length} par plugin · ${
    inv.projectRoot ? `projet : ${inv.projectRoot}` : 'aucun projet choisi'
  }`;
}

function skillsProject() {
  return $('#skills-project').value || null;
}

async function loadSkillsView() {
  const list = $('#skills-list');
  list.innerHTML = '<div class="empty">Lecture des skills…</div>';
  try {
    const cwd = skillsProject();
    const [inv, cat] = await Promise.all([
      api('GET', `/api/skills/inventory${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
      // Claude porte le catalogue le plus complet, et Grok lit les mêmes dossiers.
      api('GET', '/api/skills?provider=claude'),
    ]);
    renderSkillsView(inv, cat.skills);
  } catch (err) {
    list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

async function showSkills() {
  showView('#skills-view');
  state.currentId = null;
  renderList();
  // Le sélecteur reprend la liste des projets déjà servie à l'écran de création.
  if (!$('#skills-project').options.length) {
    try {
      const data = await api('GET', '/api/projects');
      const groups = (data.groups || [])
        .filter((g) => g.projects.length)
        .map(
          (g) =>
            `<optgroup label="${esc(g.label)}">${g.projects
              .map((p) => `<option value="${esc(p.path)}">${esc(p.name)}</option>`)
              .join('')}</optgroup>`
        )
        .join('');
      $('#skills-project').innerHTML = `<option value="">Aucun — skills globales seulement</option>${groups}`;
    } catch {
      $('#skills-project').innerHTML = '<option value="">Aucun</option>';
    }
  }
  await loadSkillsView();
  await loadAtelier();
}

// --- Atelier des skills ----------------------------------------------------
//
// Le chat qui écrit les skills. Rien n'est appliqué ici : l'agent écrit les fichiers lui-même,
// et ce qui revient est l'inventaire du disque — la seule source qui ne mente pas sur ce qui
// existe vraiment. D'où l'ordre à la fin d'un échange : on repeint la liste depuis l'inventaire
// reçu, on ne croit pas l'agent sur parole.
//
// Le fil vit côté serveur : il survit à un rechargement, et l'atelier ouvert sur le téléphone
// montre la même chose. Le direct, lui, ne survit pas — c'est du flux, comme le streaming d'une
// conversation.

let atelierBusy = false;
let atelierLive = '';

function atelierProvider() {
  return $('#atelier-provider').value || 'claude';
}

function renderAtelierLog(messages) {
  const log = $('#atelier-log');
  if (!messages || !messages.length) {
    log.innerHTML =
      '<div class="empty">Décris ce que tu veux : créer, modifier, renommer ou supprimer une ' +
      'skill. L’agent écrit les fichiers au bon endroit.</div>';
    return;
  }
  log.innerHTML = messages
    .map(
      (m) =>
        `<div class="atelier-msg atelier-${m.role === 'user' ? 'you' : 'agent'}">${
          m.role === 'user' ? esc(m.text) : md(m.text)
        }</div>`
    )
    .join('');
  log.scrollTop = log.scrollHeight;
}

/** Ce que l'agent est en train de faire. Éphémère : remplacé par sa réponse à la fin. */
const ATELIER_START = 'L’agent démarre…';

function renderAtelierLive(text) {
  const box = $('#atelier-live');
  atelierLive = text;
  box.classList.toggle('hidden', !text);
  box.textContent = text;
  box.scrollTop = box.scrollHeight;
}

/**
 * Ajoute au direct, borné par la fin. Un turn d'atelier lit des fichiers : sans borne, le
 * direct pousserait le champ de saisie hors de l'écran.
 */
function appendAtelierLive(chunk) {
  const base = atelierLive === ATELIER_START ? '' : atelierLive;
  renderAtelierLive(`${base}${chunk}`.slice(-1200));
}

function setAtelierBusy(on) {
  atelierBusy = Boolean(on);
  $('#btn-atelier-send').classList.toggle('hidden', atelierBusy);
  $('#btn-atelier-stop').classList.toggle('hidden', !atelierBusy);
  $('#atelier-input').disabled = atelierBusy;
  if (!atelierBusy) renderAtelierLive('');
}

async function loadAtelier() {
  if (!$('#atelier-provider').options.length) {
    $('#atelier-provider').innerHTML = ['claude', 'codex', 'grok']
      .map((p) => `<option value="${p}">${p}</option>`)
      .join('');
  }
  try {
    const data = await api('GET', '/api/skills/chat');
    renderAtelierLog(data.messages);
    setAtelierBusy(data.running);
  } catch (err) {
    $('#atelier-error').textContent = err.message;
  }
}

async function sendAtelier() {
  const box = $('#atelier-input');
  const message = box.value.trim();
  if (!message || atelierBusy) return;
  $('#atelier-error').textContent = '';
  box.value = '';
  setAtelierBusy(true);
  renderAtelierLive(ATELIER_START);
  try {
    const data = await api('POST', '/api/skills/chat', {
      message,
      provider: atelierProvider(),
      cwd: skillsProject(),
    });
    renderAtelierLog(data.messages);
    // La liste se relit depuis le disque, sans croire l'agent sur parole quant à ce qu'il a
    // écrit — c'est aussi ce qui montre une skill créée sous un nom différent de celui demandé.
    await loadSkillsView();
  } catch (err) {
    $('#atelier-error').textContent = err.message;
    box.value = message;
  } finally {
    setAtelierBusy(false);
  }
}

$('#btn-atelier-send').addEventListener('click', sendAtelier);
$('#btn-atelier-stop').addEventListener('click', async () => {
  try {
    await api('POST', '/api/skills/chat/stop');
  } catch (err) {
    $('#atelier-error').textContent = err.message;
  }
});
$('#atelier-input').addEventListener('keydown', (e) => {
  if (bulletKey($('#atelier-input'), e)) return void e.preventDefault();
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendAtelier();
  }
});
$('#btn-atelier-reset').addEventListener('click', () => {
  undoToast({
    message: 'Fil d’atelier oublié — les skills écrites restent sur le disque',
    hide: $('#atelier-log'),
    run: async () => {
      try {
        const data = await api('DELETE', '/api/skills/chat');
        $('#atelier-log').classList.remove('vanishing');
        renderAtelierLog(data.messages);
      } catch (err) {
        $('#atelier-error').textContent = err.message;
        throw err;
      }
    },
  });
});

$('#btn-skills').addEventListener('click', () => {
  showSkills();
  document.body.classList.remove('nav-open');
});
$('#btn-skills-refresh').addEventListener('click', loadSkillsView);
$('#btn-skills-back').addEventListener('click', () => document.body.classList.add('nav-open'));
$('#skills-project').addEventListener('change', loadSkillsView);

$('#skills-list').addEventListener('click', async (e) => {
  const move = e.target.closest('[data-skill-move]');
  const del = e.target.closest('[data-skill-del]');
  if (!move && !del) return;
  try {
    if (move) {
      const { skillMove: name, from, to } = move.dataset;
      await api('POST', `/api/skills/${encodeURIComponent(name)}/move`, {
        from,
        to,
        cwd: skillsProject(),
      });
    } else {
      const { skillDel: name, scope } = del.dataset;
      const cwd = skillsProject();
      return void undoToast({
        message: `Skill /${name} supprimée — le fichier est effacé`,
        hide: del.closest('.skill-row'),
        run: async () => {
          try {
            await api(
              'DELETE',
              `/api/skills/${encodeURIComponent(name)}?scope=${scope}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''}`
            );
            await loadSkillsView();
          } catch (err) {
            $('#skills-list').insertAdjacentHTML('afterbegin', `<div class="empty">${esc(err.message)}</div>`);
            throw err;
          }
        },
      });
    }
    await loadSkillsView();
  } catch (err) {
    $('#skills-list').insertAdjacentHTML('afterbegin', `<div class="empty">${esc(err.message)}</div>`);
  }
});

$('#btn-skill-create').addEventListener('click', async () => {
  const err = $('#skill-error');
  err.textContent = '';
  const scope = $('#skill-scope').value;
  if (scope === 'project' && !skillsProject()) {
    return void (err.textContent = 'Choisis un projet au-dessus, ou passe la portée en globale.');
  }
  $('#btn-skill-create').disabled = true;
  try {
    await api('POST', '/api/skills', {
      name: $('#skill-name').value.trim(),
      description: $('#skill-desc').value.trim(),
      body: $('#skill-body').value,
      scope,
      cwd: skillsProject(),
    });
    for (const id of ['#skill-name', '#skill-desc', '#skill-body']) $(id).value = '';
    $('#skill-form').open = false;
    await loadSkillsView();
  } catch (e2) {
    err.textContent = e2.message;
  } finally {
    $('#btn-skill-create').disabled = false;
  }
});

// --- Envoyer un message plus tard ------------------------------------------
//
// Le cas : le contexte est construit — ticket lu, branche identifiée — et l'action doit
// partir à 18 h. Retaper le message à 18 h, c'est risquer de se tromper de branche ; le
// planifier maintenant, c'est le faire pendant qu'on a tout en tête.
//
// L'enregistrement est côté serveur : le navigateur peut être fermé, le PC éteint.

let planMode = 'fork';

/** Arrondi à l'heure ronde suivante : personne ne planifie à la seconde. */
function nextRoundHour() {
  const at = new Date(Date.now() + 3_600_000);
  at.setMinutes(0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

function renderPlanMode() {
  for (const btn of $('#plan-mode').querySelectorAll('[data-plan-mode]')) {
    btn.classList.toggle('active', btn.dataset.planMode === planMode);
  }
  const provider = state.current ? state.current.provider : '';
  // Trois cas, et la note doit dire lequel : le contexte est-il figé maintenant, seulement
  // isolé à l'échéance, ou pas dérivé du tout ?
  const freezable = ((state.models && state.models.freezable) || []).includes(provider);
  const forkable = ((state.models && state.models.forkable) || []).includes(provider);

  $('#plan-mode-note').textContent =
    planMode !== 'fork'
      ? "Le message rejoint cette conversation à l'échéance. Ce que tu diras d'ici là le précédera."
      : freezable
        ? "La copie est prise maintenant, avec le contexte tel qu'il est à cet instant. Elle apparaît tout de suite dans la sidebar, en attente — et tu peux continuer cette conversation sans l'affecter."
        : forkable
          ? `${provider} ne sait pas figer une session : la copie sera dérivée à l'échéance et héritera donc de l'état du parent à ce moment-là. Le fil reste libre, mais le contexte n'est pas gelé.`
          : `${provider || 'Ce fournisseur'} ne sait pas dériver une session : le message partira dans cette conversation.`;
}

$('#plan-mode').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-plan-mode]');
  if (!btn) return;
  planMode = btn.dataset.planMode;
  renderPlanMode();
});

function renderPlanList(list) {
  const el = $('#plan-list');
  const waiting = (list || []).filter((p) => p.status === 'pending');
  if (!waiting.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML =
    '<div class="plan-list-head">Déjà planifié dans cette conversation</div>' +
    waiting
      .map(
        (p) => `<div class="plan-row">
          <span class="plan-when">${esc(whenLabel(p.runAt))}</span>
          <span class="plan-mode">${p.mode === 'fork' ? 'copie' : 'ici'}</span>
          <span class="plan-text">${esc(p.prompt.split('\n')[0].slice(0, 60))}</span>
          <button class="ghost" data-plan-cancel="${esc(p.id)}" title="Annuler">
            <svg class="icon"><use href="#i-trash"/></svg>
          </button>
        </div>`
      )
      .join('');
}

async function openPlan() {
  if (!state.currentId) return;
  $('#plan-error').textContent = '';
  // Le message déjà écrit dans le composeur est le candidat évident : on le reprend, puces
  // reconverties — c'est bien ce texte-là qui partira.
  $('#plan-text').value = bullets.toMarkdown($('#prompt').value).trim();
  $('#plan-at').value = nextRoundHour();
  renderPlanMode();
  $('#plan-list').innerHTML = '';
  $('#plan-modal').classList.remove('hidden');
  $('#plan-text').focus();
  try {
    const data = await api('GET', '/api/planned');
    renderPlanList((data.planned || []).filter((p) => p.convId === state.currentId));
  } catch {
    /* la liste est un confort : son absence n'empêche pas de planifier */
  }
}

function closePlan() {
  $('#plan-modal').classList.add('hidden');
}

$('#btn-plan').addEventListener('click', openPlan);
$('#plan-cancel').addEventListener('click', closePlan);
$('#plan-modal').addEventListener('click', (e) => {
  if (e.target.id === 'plan-modal') closePlan();
});

$('#plan-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-plan-cancel]');
  if (!btn) return;
  try {
    await api('DELETE', `/api/planned/${btn.dataset.planCancel}`);
    const data = await api('GET', '/api/planned');
    renderPlanList((data.planned || []).filter((p) => p.convId === state.currentId));
  } catch (err) {
    $('#plan-error').textContent = err.message;
  }
});

$('#plan-ok').addEventListener('click', async () => {
  const err = $('#plan-error');
  err.textContent = '';
  const prompt = $('#plan-text').value.trim();
  if (!prompt) return void (err.textContent = 'Écris le message à envoyer.');
  if (!$('#plan-at').value) return void (err.textContent = 'Choisis la date et l’heure.');

  $('#plan-ok').disabled = true;
  try {
    const data = await api('POST', `/api/conversations/${state.currentId}/planned`, {
      prompt,
      // `datetime-local` rend l'heure murale, sans fuseau : c'est bien ce qu'on veut, le
      // serveur tourne sur le même.
      runAt: $('#plan-at').value,
      mode: planMode,
    });
    renderPlanList(data.pending);
    // Le message est parti dans la file du serveur : le laisser dans le composeur ferait
    // croire qu'il reste à envoyer.
    if (bullets.toMarkdown($('#prompt').value).trim() === prompt) {
      $('#prompt').value = '';
      autosizePrompt();
    }
    $('#plan-text').value = '';
  } catch (e2) {
    err.textContent = e2.message;
  } finally {
    $('#plan-ok').disabled = false;
  }
});

// --- Skills : autocomplétion dans le composeur -----------------------------
//
// Il n'y a rien à exécuter côté app : écrire `/nom` dans le message suffit, le CLI déroule
// la skill (et agentHub la déroule pour Codex, qui ne sait pas). Ce qui manquait était de
// savoir ce qui existe : sans liste, il faut connaître le nom par cœur.
//
// Le champ est un `<textarea>` : on ne peut pas y colorer une partie du texte, seule une
// zone `contenteditable` le permettrait — au prix de tout le reste (collage, dictée,
// redimensionnement). D'où un badge au-dessus du champ quand la skill est reconnue, et la
// coloration dans le fil, où c'est du HTML.

/** Skills du fournisseur courant, chargées à l'ouverture d'une conversation. */
async function loadSkills(provider) {
  if (!provider || state.skillsOf === provider) return;
  try {
    const data = await api('GET', `/api/skills?provider=${encodeURIComponent(provider)}`);
    state.skills = data.skills || [];
    state.skillsOf = provider;
  } catch {
    state.skills = [];
  }
}

/** Le mot en cours de frappe, s'il commence la ligne par « / ». */
function skillQuery() {
  const el = $('#prompt');
  const upto = el.value.slice(0, el.selectionStart);
  // Uniquement en tête de message : `/x` au milieu d'une phrase n'est pas une commande.
  const match = /^\/([a-z0-9:-]*)$/i.exec(upto);
  return match ? match[1].toLowerCase() : null;
}

function renderSkillMenu() {
  const box = $('#skill-menu');
  const term = skillQuery();
  if (term === null) {
    box.classList.add('hidden');
    state.skillPick = -1;
    return;
  }

  // Le nom court d'abord : on cherche « commit », pas « compound-engineering:ce-commit ».
  const bare = (s) => (s.name.includes(':') ? s.name.slice(s.name.indexOf(':') + 1) : s.name);
  const found = (state.skills || [])
    .filter((s) => bare(s).includes(term) || s.name.toLowerCase().includes(term))
    .sort((a, b) => {
      const ap = bare(a).startsWith(term) ? 0 : 1;
      const bp = bare(b).startsWith(term) ? 0 : 1;
      return ap - bp || bare(a).localeCompare(bare(b));
    })
    .slice(0, 12);

  state.skillFound = found;
  if (!found.length) {
    box.classList.add('hidden');
    return;
  }
  if (state.skillPick < 0 || state.skillPick >= found.length) state.skillPick = 0;

  box.innerHTML = found
    .map(
      (s, i) => `<button class="skill-opt${i === state.skillPick ? ' on' : ''}" data-skill="${esc(
        s.name
      )}">
        <span class="skill-opt-name">/${esc(s.name)}</span>
        ${s.description ? `<span class="skill-opt-desc">${esc(s.description)}</span>` : ''}
      </button>`
    )
    .join('');
  box.classList.remove('hidden');
}

function pickSkill(name) {
  const el = $('#prompt');
  // Remplace le `/mot` en cours, garde ce qui suit — on peut compléter au milieu d'un
  // message déjà écrit.
  el.value = el.value.replace(/^\/[a-z0-9:-]*/i, `/${name}`);
  const at = name.length + 1;
  el.focus();
  el.setSelectionRange(at, at);
  // Une espace derrière : la skill prend souvent un argument.
  if (!el.value.slice(at).startsWith(' ')) {
    el.value = `${el.value.slice(0, at)} ${el.value.slice(at)}`;
    el.setSelectionRange(at + 1, at + 1);
  }
  $('#skill-menu').classList.add('hidden');
  autosizePrompt();
  renderSkillBadge();
}

/** Badge qui confirme que la skill écrite est connue — le pendant du « bleu » du terminal. */
function renderSkillBadge() {
  const badge = $('#skill-badge');
  const match = /^\/([a-z0-9:-]+)/i.exec($('#prompt').value.trim());
  const found = match && (state.skills || []).find((s) => s.name.toLowerCase() === match[1].toLowerCase());
  if (!found) {
    badge.classList.add('hidden');
    return;
  }
  badge.innerHTML =
    `<code>/${esc(found.name)}</code>` +
    (found.description ? `<span>${esc(found.description)}</span>` : '');
  badge.classList.remove('hidden');
}

$('#skill-menu').addEventListener('click', (e) => {
  const opt = e.target.closest('[data-skill]');
  if (opt) pickSkill(opt.dataset.skill);
});

// --- Puces : « - » puis une espace ----------------------------------------
//
// La décision est dans `bullets.js`, testée sans navigateur. Ici on ne fait que la donner à
// la saisie du champ — par `execCommand('insertText')`, déprécié mais seul chemin qui garde
// la pile d'annulation : réécrire `value` la vide, et Ctrl+Z ne rendrait plus rien de ce qui
// a été tapé avant.

function applyEdit(el, edit) {
  if (!edit) return false;
  el.setSelectionRange(edit.from, edit.to);
  let done = false;
  try {
    done = document.execCommand('insertText', false, edit.text);
  } catch {
    done = false;
  }
  if (!done) {
    const out = bullets.apply(el.value, edit);
    el.value = out.value;
    el.setSelectionRange(out.caret, out.caret);
  }
  // Le composeur grandit avec son contenu ; le champ de création, non.
  if (el.id === 'prompt') autosizePrompt();
  return true;
}

/**
 * Frappe qui concerne les puces, dans n'importe quel champ de saisie de message.
 *
 * Rien ne se déclenche sur une sélection en cours : l'utilisateur remplace du texte, il
 * n'écrit pas une liste.
 *
 * @param {boolean} [plainEnter] true là où Entrée saute une ligne au lieu d'envoyer — c'est le
 *   cas du champ de création, qui s'envoie par Ctrl+Entrée
 * @returns {boolean} true si la frappe a été traitée — l'appelant doit alors l'annuler
 */
function bulletKey(el, e, plainEnter) {
  if (el.selectionStart !== el.selectionEnd) return false;
  const at = el.selectionStart;
  if (e.key === ' ') return applyEdit(el, bullets.onSpace(el.value, at));
  if (e.key === 'Enter' && (e.shiftKey || plainEnter) && !e.metaKey && !e.ctrlKey) {
    return applyEdit(el, bullets.onNewline(el.value, at));
  }
  if (e.key === 'Backspace') return applyEdit(el, bullets.onBackspace(el.value, at));
  return false;
}

$('#prompt').addEventListener('keydown', (e) => {
  const menu = $('#skill-menu');
  const open = !menu.classList.contains('hidden');

  // Avant le menu des skills : aucune de ces touches ne lui sert, et une puce doit se poser
  // même quand le menu est ouvert.
  if (bulletKey($('#prompt'), e)) {
    e.preventDefault();
    renderSkillMenu();
    renderSkillBadge();
    return;
  }

  if (open) {
    // Le menu capte les flèches et la tabulation ; Échap le referme sans rien envoyer.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = (state.skillFound || []).length;
      state.skillPick = (state.skillPick + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      renderSkillMenu();
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      const chosen = (state.skillFound || [])[state.skillPick];
      if (chosen) {
        e.preventDefault();
        pickSkill(chosen.name);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      menu.classList.add('hidden');
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
function autosizePrompt() {
  const el = $('#prompt');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  el.classList.toggle('scrolls', el.scrollHeight > 260);
}

$('#prompt').addEventListener('input', () => {
  autosizePrompt();
  renderSkillMenu();
  renderSkillBadge();
});
// Le menu suit le curseur : cliquer ailleurs dans le champ doit le refermer.
$('#prompt').addEventListener('click', renderSkillMenu);
$('#prompt').addEventListener('blur', () => {
  // Différé : sans ça, cliquer une entrée du menu le referme avant que le clic n'arrive.
  setTimeout(() => $('#skill-menu').classList.add('hidden'), 150);
});
$('#new-prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return void $('#btn-create').click();
  // Le champ de création est un composeur comme l'autre : la première consigne est souvent
  // celle qui a le plus besoin d'une liste. Entrée y saute une ligne, sans Maj.
  if (bulletKey($('#new-prompt'), e, true)) e.preventDefault();
});

$('#conv-title').addEventListener('dblclick', async () => {
  const id = state.currentId;
  const title = await askInput({ title: 'Renommer', label: 'Titre', value: state.current.title });
  if (!title || !title.trim()) return;
  await api('PATCH', `/api/conversations/${id}`, { title });
  if (state.currentId === id) {
    state.current.title = title;
    renderHead();
  }
  await refreshList();
});

$('#btn-delete').addEventListener('click', () => deleteConvWithUndo(state.currentId));

// --- File d'attente -------------------------------------------------------
//
// Les messages préparés pendant qu'un agent travaille s'empilent ici, au-dessus du
// champ, et n'entrent dans le fil qu'au moment de partir. Éditables, supprimables,
// réordonnables, images comprises. La file vit sur le serveur : elle survit à un
// rechargement et se synchronise entre appareils.

// Partagé avec le sélecteur de la file, créé plus bas : la constante doit exister
// avant cette ligne, le reste du traitement des pièces jointes vit plus loin.
const ACCEPT_FILES =
  'image/png,image/jpeg,image/webp,image/gif,.md,.markdown,.json,text/markdown,application/json';

let editingQueueId = null;
let queueImageTarget = null;

function queueCard(entry, index) {
  const images = (entry.images || []).map((img) => queueThumb(entry, img)).join('');

  const editing = editingQueueId === entry.id;
  return `<div class="queue-card${editing ? ' editing' : ''}" data-qcard="${entry.id}" draggable="true" data-index="${index}">
    <span class="queue-grip" title="Glisser pour réordonner"><svg class="icon"><use href="#i-grip"/></svg></span>
    <div class="queue-main">
      <div class="queue-text">${esc(entry.text)}</div>
      <div class="queue-edit">
        <textarea data-qedit="${entry.id}">${esc(entry.text)}</textarea>
        <div class="queue-edit-foot">
          <button class="queue-btn" data-qsave="${entry.id}"><svg class="icon"><use href="#i-check"/></svg><span>Enregistrer</span></button>
          <button class="queue-btn" data-qcancel="${entry.id}"><svg class="icon"><use href="#i-close"/></svg><span>Annuler</span></button>
          <button class="queue-btn" data-qaddimg="${entry.id}"><svg class="icon"><use href="#i-paperclip"/></svg><span>Ajouter un fichier</span></button>
        </div>
      </div>
      ${images ? `<div class="queue-images">${images}</div>` : ''}
    </div>
    <div class="queue-actions">
      <button class="queue-btn queue-send" data-qsend="${entry.id}" title="Envoyer comme instruction"><svg class="icon"><use href="#i-arrow-right"/></svg><span>Envoyer</span></button>
      <button class="queue-btn" data-qeditbtn="${entry.id}" title="Modifier"><svg class="icon"><use href="#i-pencil"/></svg></button>
      <button class="queue-btn danger-ghost" data-qdel="${entry.id}" title="Supprimer"><svg class="icon"><use href="#i-trash"/></svg></button>
    </div>
  </div>`;
}

function renderQueue() {
  const box = $('#queue');
  const queue = state.queue || [];
  if (!queue.length) {
    box.innerHTML = '';
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML =
    `<div class="queue-head"><span>${queue.length} message${queue.length > 1 ? 's' : ''} en attente — partiront dans cet ordre</span></div>` +
    queue.map(queueCard).join('');
}

async function queueApi(method, path, body) {
  const data = await api(method, `/api/conversations/${state.currentId}/queue${path}`, body);
  if (data.queued) {
    state.queue = data.queued;
    renderQueue();
  }
  return data;
}

$('#queue').addEventListener('click', async (e) => {
  const hit = (attr) => {
    const el = e.target.closest(`[data-${attr}]`);
    return el ? el.dataset[attr] : null;
  };

  try {
    const removeImg = e.target.closest('[data-qimg-remove]');
    if (removeImg) {
      const qid = removeImg.closest('[data-qcard]').dataset.qcard;
      await queueApi('PATCH', `/${qid}`, { removeImageUrls: [removeImg.dataset.qimgRemove] });
      return;
    }

    const file = e.target.closest('[data-qfile]');
    if (file && !e.target.closest('[data-qimg-remove]')) {
      window.open(file.dataset.qfile, '_blank', 'noopener');
      return;
    }

    const thumb = e.target.closest('[data-qimg]');
    if (thumb) {
      openLightbox(thumb.dataset.qimg, thumb.dataset.qname || '');
      return;
    }

    const send = hit('qsend');
    if (send) {
      await api('POST', `/api/conversations/${state.currentId}/queue/${send}/promote`);
      return;
    }

    const del = hit('qdel');
    if (del) {
      await queueApi('DELETE', `/${del}`);
      return;
    }

    const edit = hit('qeditbtn');
    if (edit) {
      editingQueueId = edit;
      renderQueue();
      const area = document.querySelector(`[data-qedit="${edit}"]`);
      if (area) {
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      }
      return;
    }

    const cancel = hit('qcancel');
    if (cancel) {
      editingQueueId = null;
      renderQueue();
      return;
    }

    const save = hit('qsave');
    if (save) {
      const area = document.querySelector(`[data-qedit="${save}"]`);
      const text = area ? area.value.trim() : '';
      if (!text) return;
      editingQueueId = null;
      await queueApi('PATCH', `/${save}`, { text });
      return;
    }

    const addImg = hit('qaddimg');
    if (addImg) {
      queueImageTarget = addImg;
      $('#queue-file-input').click();
    }
  } catch (err) {
    toastError(err.message);
  }
});

// Ajout d'images à un message déjà en attente
const queueFileInput = document.createElement('input');
queueFileInput.type = 'file';
queueFileInput.id = 'queue-file-input';
queueFileInput.accept = ACCEPT_FILES;
queueFileInput.multiple = true;
queueFileInput.hidden = true;
document.body.appendChild(queueFileInput);

queueFileInput.addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length || !queueImageTarget) return;
  try {
    const addImages = await Promise.all(
      files.map(
        (file) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve({ name: file.name, dataUrl: reader.result });
            reader.onerror = () => reject(new Error(`${file.name} : lecture impossible`));
            reader.readAsDataURL(file);
          })
      )
    );
    await queueApi('PATCH', `/${queueImageTarget}`, { addImages });
  } catch (err) {
    toastError(err.message);
  } finally {
    queueImageTarget = null;
  }
});

// Réordonnancement par glisser-déposer
let dragId = null;

$('#queue').addEventListener('dragstart', (e) => {
  const card = e.target.closest('[data-qcard]');
  if (!card || editingQueueId) return;
  dragId = card.dataset.qcard;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});

$('#queue').addEventListener('dragover', (e) => {
  if (!dragId) return;
  e.preventDefault();
  const card = e.target.closest('[data-qcard]');
  document.querySelectorAll('.queue-card.drop-target').forEach((c) => c.classList.remove('drop-target'));
  if (card && card.dataset.qcard !== dragId) card.classList.add('drop-target');
});

$('#queue').addEventListener('dragend', () => {
  document.querySelectorAll('.dragging, .drop-target').forEach((c) => {
    c.classList.remove('dragging', 'drop-target');
  });
  dragId = null;
});

$('#queue').addEventListener('drop', async (e) => {
  e.preventDefault();
  const card = e.target.closest('[data-qcard]');
  if (!dragId || !card || card.dataset.qcard === dragId) return;

  const ids = (state.queue || []).map((q) => q.id);
  const from = ids.indexOf(dragId);
  const to = ids.indexOf(card.dataset.qcard);
  if (from === -1 || to === -1) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);

  dragId = null;
  try {
    await queueApi('POST', '/order', { ids });
  } catch (err) {
    toastError(err.message);
  }
});

// --- Pièces jointes -------------------------------------------------------
//
// Elles restent côté client jusqu'à l'envoi : la vignette vient d'une URL d'objet
// locale, donc aucun aller-retour serveur pour l'aperçu. À l'envoi, elles partent
// en data URL avec le message, et le serveur les écrit sur disque — un chemin pour
// les images, le contenu recopié dans le prompt pour le markdown et le JSON.

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const TEXT_EXTS = new Set(['md', 'markdown', 'json']);

let pendingImages = [];
let attachSeq = 0;

function fileExtOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(name || '');
  return match ? match[1].toLowerCase() : '';
}

function isTextName(name) {
  return TEXT_EXTS.has(fileExtOf(name));
}

function attachmentIsText(att) {
  if (!att) return false;
  if (att.kind === 'text') return true;
  if (att.kind === 'image') return false;
  return isTextName(att.name) || isTextName(att.url);
}

function textBadge(name) {
  const ext = fileExtOf(name);
  if (ext === 'md' || ext === 'markdown') return 'MD';
  if (ext === 'json') return 'JSON';
  return (ext || 'FILE').toUpperCase().slice(0, 4);
}

function attachmentKindOf(file) {
  if (file && IMAGE_MIME.includes(file.type)) return 'image';
  if (file && isTextName(file.name)) return 'text';
  return null;
}

/** Consigne quand on envoie des pièces sans texte. Les images gardent la phrase d'avant. */
function attachmentFallback(files) {
  const texts = files.filter((file) => file.kind === 'text').length;
  if (texts && texts === files.length) return texts > 1 ? 'Lis les fichiers joints.' : 'Lis le fichier joint.';
  return 'Regarde cette image.';
}

function removeButton(id) {
  return `<span class="att-x" data-remove="${id}" role="button" tabindex="0" title="Retirer"><svg class="icon"><use href="#i-close"/></svg></span>`;
}

/** Pastille d'un markdown ou d'un JSON déjà enregistré, dans le fil. Une seule ligne : le message est en pre-wrap. */
function renderStoredAttachment(att) {
  if (attachmentIsText(att)) {
    const badge = textBadge(att.name || att.url);
    return `<a class="msg-file" href="${esc(att.url)}" target="_blank" rel="noopener" title="${esc(att.name)}"><span class="msg-file-ext">${esc(badge)}</span><span class="msg-file-name">${esc(att.name)}</span></a>`;
  }
  return `<button data-image="${esc(att.url)}" data-name="${esc(att.name)}" title="${esc(att.name)}"><img src="${esc(att.url)}" alt="${esc(att.name)}" loading="lazy"></button>`;
}

/** Vignette dans la file d'attente. Le retrait passe par la même croix que les images. */
function queueThumb(entry, img) {
  const close = `<span class="att-x" data-qimg-remove="${esc(img.url)}" title="Retirer"><svg class="icon"><use href="#i-close"/></svg></span>`;
  if (attachmentIsText(img)) {
    const badge = textBadge(img.name || img.url);
    return `<button class="att att-file" data-qfile="${esc(img.url)}" data-qid="${entry.id}" title="${esc(img.name)}"><span class="att-ext">${esc(badge)}</span><span class="att-name">${esc(img.name)}</span>${close}</button>`;
  }
  return `<button class="att" data-qimg="${esc(img.url)}" data-qname="${esc(img.name)}" data-qid="${entry.id}" title="${esc(img.name)}"><img src="${esc(img.url)}" alt="">${close}</button>`;
}

function renderAttachments(error) {
  const box = $('#attachments');
  const items = pendingImages
    .map((img) => {
      if (img.kind === 'text') {
        return `<button class="att att-file" data-att="${img.id}" title="${esc(img.name)}"><span class="att-ext">${esc(textBadge(img.name))}</span><span class="att-name">${esc(img.name)}</span>${removeButton(img.id)}</button>`;
      }
      return `<button class="att" data-att="${img.id}" title="${esc(img.name)}"><img src="${img.objectUrl}" alt="${esc(img.name)}">${removeButton(img.id)}</button>`;
    })
    .join('');
  box.innerHTML = items + (error ? `<div class="att-err">${esc(error)}</div>` : '');
  box.classList.toggle('hidden', !items && !error);
}

function clearAttachments() {
  pendingImages.forEach((img) => URL.revokeObjectURL(img.objectUrl));
  pendingImages = [];
  renderAttachments();
}

function addImageFiles(files) {
  const list = [...files].filter(Boolean);
  if (!list.length) return;

  let error = '';
  for (const file of list) {
    if (pendingImages.length >= MAX_IMAGES) {
      error = `${MAX_IMAGES} pièces jointes maximum par message.`;
      break;
    }
    const kind = attachmentKindOf(file);
    if (!kind) {
      error = `${file.name || 'Fichier'} : format non pris en charge (png, jpeg, webp, gif, md, json).`;
      continue;
    }
    const cap = kind === 'text' ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES;
    if (file.size > cap) {
      const maxMo = kind === 'text' ? 2 : 10;
      const label = kind === 'text' ? 'Fichier' : 'Image';
      error = `${file.name || label} : trop lourd (${Math.round(file.size / 1e6)} Mo, ${maxMo} Mo maximum).`;
      continue;
    }

    const entry = {
      id: `att${(attachSeq += 1)}`,
      kind,
      name: file.name || (kind === 'text' ? 'fichier' : `image-collée.${(file.type || 'image/png').split('/')[1]}`),
      objectUrl: URL.createObjectURL(file),
      dataUrl: null,
    };
    pendingImages.push(entry);

    const reader = new FileReader();
    reader.onload = () => {
      entry.dataUrl = reader.result;
    };
    reader.onerror = () => {
      renderAttachments(`${entry.name} : lecture impossible.`);
      pendingImages = pendingImages.filter((i) => i !== entry);
    };
    reader.readAsDataURL(file);
  }
  renderAttachments(error);
}

$('#attachments').addEventListener('click', (e) => {
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    e.stopPropagation();
    const id = remove.dataset.remove;
    const img = pendingImages.find((i) => i.id === id);
    if (img) URL.revokeObjectURL(img.objectUrl);
    pendingImages = pendingImages.filter((i) => i.id !== id);
    renderAttachments();
    return;
  }
  const thumb = e.target.closest('[data-att]');
  if (thumb) {
    const img = pendingImages.find((i) => i.id === thumb.dataset.att);
    if (!img) return;
    if (img.kind === 'text') window.open(img.objectUrl, '_blank', 'noopener');
    else openLightbox(img.objectUrl, img.name);
  }
});

$('#attachments').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-remove]')) {
    e.preventDefault();
    e.target.closest('[data-remove]').click();
  }
});

// Joindre un fichier : depuis la machine, ou une image depuis la galerie. Le second
// chemin repasse par le premier — on récupère le fichier et on le donne à `addImageFiles`,
// qui garde ainsi le contrôle de taille et la conversion en un seul endroit.

function openAttachmentMenu(anchor) {
  $('#row-menu').innerHTML = [
    '<button data-attach="local"><svg class="icon"><use href="#i-plus"/></svg>Importer un fichier</button>',
    '<button data-attach="gallery"><svg class="icon"><use href="#i-image"/></svg>Depuis la galerie</button>',
  ].join('');
  // Pas de point ici : ce menu s'ouvre au bouton « joindre » du composeur, jamais au clic droit.
  placeMenu(anchor);
}

$('#btn-attach').addEventListener('click', (e) => {
  e.stopPropagation();
  openAttachmentMenu($('#btn-attach'));
});

$('#file-input').addEventListener('change', (e) => {
  addImageFiles(e.target.files);
  e.target.value = ''; // permet de re-sélectionner le même fichier
});

/**
 * Convertit un SVG en PNG, dans le navigateur.
 *
 * Les pièces jointes doivent être matricielles : c'est ce que les CLIs savent lire, et
 * la table de types de Grok ne connaît pas le SVG. Or deux agents sur trois produisent
 * du SVG — sans cette conversion, la plus grande partie de la galerie serait
 * impossible à joindre.
 */
function svgToPng(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      // Un SVG n'a pas toujours de dimensions intrinsèques : sans viewBox dimensionné,
      // le navigateur rend 0. On retombe alors sur un carré confortable.
      const w = img.naturalWidth || 1024;
      const h = img.naturalHeight || 1024;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob((png) => {
        if (png) resolve(png);
        else reject(new Error('Conversion du SVG impossible'));
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVG illisible'));
    };
    img.src = url;
  });
}

/** Récupère une image de la galerie et la joint comme si elle venait du disque. */
async function attachFromGallery(imageId, label) {
  const res = await fetch(`/api/gallery/images/${imageId}/file`);
  if (!res.ok) throw new Error('Image introuvable');

  let blob = await res.blob();
  if (blob.type.includes('svg')) blob = await svgToPng(blob);

  const ext = (blob.type.split('/')[1] || 'png').split('+')[0];
  addImageFiles([new File([blob], `${label || 'galerie'}.${ext}`, { type: blob.type })]);
}

function galleryPickerBody(projects, current, images) {
  const options = projects.length
    ? projects
        .map(
          (p) =>
            `<option value="${p.id}"${p.id === current ? ' selected' : ''}>${esc(p.name)} (${
              p.count
            })</option>`
        )
        .join('')
    : '<option value="">Aucun projet</option>';

  const grid = images.length
    ? images
        .map(
          (i) =>
            `<button class="pick-img" data-pick="${i.id}" data-label="${esc(
              PROVIDER_LABELS[i.provider] || i.provider
            )}" title="${esc(i.prompt)}">
              <img src="/api/gallery/images/${i.id}/file" alt="${esc(i.prompt)}" decoding="async">
              <span>${providerIcon(i.provider)}</span>
            </button>`
        )
        .join('')
    : '<div class="empty">Aucune image dans ce projet.</div>';

  return `<div class="relay-field">
      <label class="relay-label" for="pick-project">Projet</label>
      <select id="pick-project">${options}</select>
    </div>
    <div class="pick-grid">${grid}</div>
    <div id="modal-error" class="modal-warn hidden"></div>`;
}

async function openGalleryPicker() {
  openModal('Depuis la galerie', '<p>Chargement…</p>', '', null);

  const load = async (projectId) => {
    const { projects } = await api('GET', '/api/gallery');
    const pick = projects.some((p) => p.id === projectId)
      ? projectId
      : (projects[0] || {}).id || '';
    const images = pick
      ? (await api('GET', `/api/gallery/projects/${pick}/images`)).images.filter(
          (i) => i.state === 'done' && i.file
        )
      : [];

    $('#modal-body').innerHTML = galleryPickerBody(projects, pick, images);

    const select = $('#pick-project');
    if (select) select.addEventListener('change', () => load(select.value));
  };

  try {
    await load(PREFS.read(GAL.projectKey, null));
  } catch (err) {
    $('#modal-body').innerHTML = `<div class="modal-warn">${esc(err.message)}</div>`;
  }
}

$('#modal-body').addEventListener('click', async (e) => {
  const pick = e.target.closest('[data-pick]');
  if (!pick) return;
  try {
    await attachFromGallery(pick.dataset.pick, pick.dataset.label);
    closeModal();
  } catch (err) {
    const slot = $('#modal-error');
    if (slot) {
      slot.textContent = err.message;
      slot.classList.remove('hidden');
    }
  }
});

// Coller une image depuis le presse-papier
$('#prompt').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])];
  if (files.length) {
    e.preventDefault();
    addImageFiles(files);
  }
});

// Glisser-déposer sur la zone de saisie
const composer = $('#composer');
['dragenter', 'dragover'].forEach((type) =>
  composer.addEventListener(type, (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    composer.classList.add('dropping');
  })
);
['dragleave', 'dragend'].forEach((type) =>
  composer.addEventListener(type, (e) => {
    if (e.target === composer || !composer.contains(e.relatedTarget)) {
      composer.classList.remove('dropping');
    }
  })
);
composer.addEventListener('drop', (e) => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  composer.classList.remove('dropping');
  addImageFiles(e.dataTransfer.files);
});

// --- Galerie ----------------------------------------------------------------
//
// Indépendante des conversations : ses projets ne sont pas les dossiers de la sidebar.
// Une description envoyée à plusieurs agents forme un lot, affiché sur une ligne pour
// que la comparaison soit immédiate.

const GAL = {
  projectKey: 'galleryProject',
  agentsKey: 'galleryAgents',
};

function galSelectedAgents() {
  return [...document.querySelectorAll('#gal-agents .gal-agent.on')].map((b) => b.dataset.agent);
}

function renderGalAgents() {
  const chosen = new Set(PREFS.read(GAL.agentsKey, usableProviders()));
  $('#gal-agents').innerHTML = usableProviders()
    .map((p) => {
      const on = chosen.has(p) ? ' on' : '';
      return `<button class="gal-agent${on}" data-agent="${p}" title="${esc(
        PROVIDER_LABELS[p] || p
      )}">${providerIcon(p)}<span>${esc(PROVIDER_LABELS[p] || p)}</span></button>`;
    })
    .join('');
}

function galImageCard(img) {
  const name = `${PROVIDER_LABELS[img.provider] || img.provider}`;
  const cost = img.costUsd ? `<span class="gal-cost">${money(img.costUsd)}</span>` : '';

  let body;
  if (img.state === 'working') {
    body = '<div class="gal-pending">génération…</div>';
  } else if (img.state === 'done' && img.file) {
    const url = `/api/gallery/images/${img.id}/file`;
    // Pas de `loading="lazy"` ici, contrairement aux images du fil : dans une grille
    // insérée d'un coup, l'observateur d'intersection ne se déclenchait pas et les
    // vignettes restaient vides. Une galerie personnelle tient largement le chargement.
    body = `<img class="gal-img" src="${url}" alt="${esc(img.prompt)}"
      data-zoom="${url}" data-name="${esc(name)}" decoding="async">`;
  } else {
    body = `<div class="gal-failed" title="${esc(img.error || '')}">${esc(
      (img.error || 'Aucune image produite').slice(0, 90)
    )}</div>`;
  }

  return `<figure class="gal-card${img.state === 'failed' ? ' failed' : ''}" data-image="${img.id}">
    ${body}
    <figcaption>
      ${providerIcon(img.provider)}
      <span class="gal-who">${esc(name)}</span>
      ${cost}
      <button class="gal-del" data-del="${img.id}" title="Supprimer">
        <svg class="icon"><use href="#i-trash"/></svg>
      </button>
    </figcaption>
  </figure>`;
}

function renderGalBatches(images) {
  if (!images.length) {
    $('#gal-batches').innerHTML =
      '<div class="empty">Aucune image dans ce projet. Décris ce que tu veux, choisis les agents, et lance.</div>';
    return;
  }

  // Regroupé par lot : une description, les agents côte à côte.
  const order = [];
  const byBatch = new Map();
  for (const img of images) {
    const key = img.batchId || img.id;
    if (!byBatch.has(key)) {
      byBatch.set(key, []);
      order.push(key);
    }
    byBatch.get(key).push(img);
  }

  $('#gal-batches').innerHTML = order
    .map((key) => {
      const batch = byBatch.get(key);
      return `<section class="gal-batch">
        <p class="gal-prompt">${esc(batch[0].prompt)}</p>
        <div class="gal-row">${batch.map(galImageCard).join('')}</div>
      </section>`;
    })
    .join('');
}

async function loadGalleryImages() {
  const id = $('#gal-project').value;
  if (!id) {
    $('#gal-batches').innerHTML =
      '<div class="empty">Crée un projet pour commencer.</div>';
    $('#gallery-sub').textContent = 'Aucun projet';
    return;
  }
  try {
    const { images } = await api('GET', `/api/gallery/projects/${id}/images`);
    state.galImages = images;
    renderGalBatches(images);
    const done = images.filter((i) => i.state === 'done').length;
    const spent = images.reduce((s, i) => s + (i.costUsd || 0), 0);
    $('#gallery-sub').textContent = `${done} image${done > 1 ? 's' : ''}${
      spent ? ` · ${money(spent)}` : ''
    }`;
  } catch (err) {
    $('#gal-batches').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

async function showGallery() {
  showView('#gallery-view');
  state.currentId = null;
  renderList();
  try {
    const { projects } = await api('GET', '/api/gallery');
    state.galProjects = projects;
    const wanted = PREFS.read(GAL.projectKey, null);
    const pick = projects.some((p) => p.id === wanted) ? wanted : (projects[0] || {}).id || '';
    $('#gal-project').innerHTML = projects.length
      ? projects
          .map(
            (p) =>
              `<option value="${p.id}"${p.id === pick ? ' selected' : ''}>${esc(p.name)} (${
                p.count
              })</option>`
          )
          .join('')
      : '<option value="">Aucun projet</option>';
    renderGalAgents();
    await loadGalleryImages();
  } catch (err) {
    $('#gal-batches').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

$('#btn-gallery').addEventListener('click', () => {
  showGallery();
  closeNav();
});
$('#btn-gallery-back').addEventListener('click', () => document.body.classList.add('nav-open'));

$('#gal-project').addEventListener('change', () => {
  PREFS.write(GAL.projectKey, $('#gal-project').value);
  loadGalleryImages();
});

$('#gal-agents').addEventListener('click', (e) => {
  const btn = e.target.closest('.gal-agent');
  if (!btn) return;
  btn.classList.toggle('on');
  PREFS.write(GAL.agentsKey, galSelectedAgents());
});

$('#btn-gal-new').addEventListener('click', async () => {
  const name = await askInput({ title: 'Nouveau projet', label: 'Nom', ok: 'Créer' });
  if (!name || !name.trim()) return;
  try {
    const { project } = await api('POST', '/api/gallery/projects', { name: name.trim() });
    PREFS.write(GAL.projectKey, project.id);
    await showGallery();
  } catch (err) {
    $('#gal-error').textContent = err.message;
  }
});

$('#btn-gal-menu').addEventListener('click', async () => {
  const id = $('#gal-project').value;
  const project = (state.galProjects || []).find((p) => p.id === id);
  if (!project) return;

  // C'était un `prompt` où il fallait TAPER « renommer » ou « supprimer » : deux boutons
  // disent la même chose sans faire écrire le mot juste.
  const action = await askChoice({
    title: `« ${project.name} »`,
    options: [
      { value: 'rename', label: 'Renommer le projet' },
      { value: 'delete', label: 'Supprimer le projet et toutes ses images', danger: true },
    ],
  });
  if (!action) return;

  if (action === 'delete') {
    return void undoToast({
      message: `« ${project.name} » et ses images supprimés`,
      run: async () => {
        try {
          await api('DELETE', `/api/gallery/projects/${id}`);
          if (PREFS.read(GAL.projectKey, null) === id) PREFS.write(GAL.projectKey, null);
          await showGallery();
        } catch (err) {
          $('#gal-error').textContent = err.message;
          throw err;
        }
      },
    });
  }

  const name = await askInput({ title: 'Renommer le projet', label: 'Nom', value: project.name });
  if (!name || !name.trim()) return;
  try {
    await api('PATCH', `/api/gallery/projects/${id}`, { name: name.trim() });
    await showGallery();
  } catch (err) {
    $('#gal-error').textContent = err.message;
  }
});

$('#btn-gal-run').addEventListener('click', async () => {
  const id = $('#gal-project').value;
  const description = $('#gal-prompt').value.trim();
  const providers = galSelectedAgents();
  const err = $('#gal-error');
  err.textContent = '';

  if (!id) return void (err.textContent = 'Crée un projet d\'abord.');
  if (!description) return void (err.textContent = 'Décris ce que tu veux.');
  if (!providers.length) return void (err.textContent = 'Choisis au moins un agent.');

  $('#btn-gal-run').disabled = true;
  try {
    await api('POST', `/api/gallery/projects/${id}/generate`, {
      prompt: description,
      providers,
    });
    $('#gal-prompt').value = '';
    await loadGalleryImages();
  } catch (e2) {
    err.textContent = e2.message;
  } finally {
    $('#btn-gal-run').disabled = false;
  }
});

$('#gal-batches').addEventListener('click', async (e) => {
  const zoom = e.target.closest('[data-zoom]');
  if (zoom) return openLightbox(zoom.dataset.zoom, zoom.dataset.name);

  const del = e.target.closest('[data-del]');
  if (!del) return;
  undoToast({
    message: 'Image supprimée',
    hide: del.closest('.gal-card'),
    run: async () => {
      try {
        await api('DELETE', `/api/gallery/images/${del.dataset.del}`);
        await loadGalleryImages();
      } catch (err) {
        $('#gal-error').textContent = err.message;
        throw err;
      }
    },
  });
});

// --- Paramètres --------------------------------------------------------------
//
// Quatre sections, un même squelette : des champs, un repère sur ce qui s'écarte du dépôt,
// et un bouton qui ESSAIE pour de vrai. C'est ce dernier qui fait la valeur de la page —
// configurer ntfy ou un SMTP à l'aveugle est exactement la raison pour laquelle ça n'avait
// jamais été fait, et un champ rempli sans preuve ne vaut pas mieux qu'un fichier non édité.
//
// Le formulaire est décrit en données plutôt qu'écrit en HTML : cinq sections recopiées à la
// main, c'est la garantie qu'une des cinq finira par diverger des autres.

const SETTINGS_FORM = [
  {
    key: 'notify',
    title: 'Notifications',
    hint:
      'Un POST sortant à la fin d’un turn, et dès qu’un agent pose une question. ' +
      'Le Web Push du navigateur est hors jeu : il exige https, or l’app est servie en http par défaut.',
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

const SETTINGS_BY_KEY = new Map(SETTINGS_FORM.map((s) => [s.key, s]));

async function showSettings() {
  showView('#settings-view');
  state.currentId = null;
  renderList();
  await loadSettings();
}

async function loadSettings() {
  try {
    const data = await api('GET', '/api/settings');
    state.settings = data.sections;
    renderSettings();
  } catch (err) {
    $('#settings-body').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function settingsField(section, field, values, overridden) {
  const id = `set-${section.key}-${field.name}`;
  const value = values[field.name];
  const changed = overridden.includes(field.name) ? ' set-changed' : '';
  const hint = field.hint ? `<p class="set-hint">${esc(field.hint)}</p>` : '';
  const name = escAttr(field.name);

  if (field.type === 'bool') {
    return `<div class="set-field set-bool${changed}">
      <label for="${id}"><input type="checkbox" id="${id}" data-set="${name}"${value ? ' checked' : ''}>
        <span>${esc(field.label)}</span></label>${hint}</div>`;
  }

  if (field.type === 'checks') {
    const boxes = field.options
      .map(
        ([v, l]) => `<label class="set-check"><input type="checkbox" data-set-item="${escAttr(v)}"${
          (value || []).includes(v) ? ' checked' : ''
        }><span>${esc(l)}</span></label>`
      )
      .join('');
    return `<div class="set-field${changed}" data-set-group="${name}">
      <span class="set-label">${esc(field.label)}</span>
      <div class="set-checks">${boxes}</div>${hint}</div>`;
  }

  if (field.type === 'select') {
    const opts = field.options
      .map(([v, l]) => `<option value="${escAttr(v)}"${value === v ? ' selected' : ''}>${esc(l)}</option>`)
      .join('');
    return `<div class="set-field${changed}"><label class="set-label" for="${id}">${esc(
      field.label
    )}</label><select id="${id}" data-set="${name}">${opts}</select>${hint}</div>`;
  }

  if (field.type === 'lines') {
    return `<div class="set-field${changed}"><label class="set-label" for="${id}">${esc(
      field.label
    )}</label><textarea id="${id}" data-set="${name}" rows="${Math.min(
      12,
      Math.max(3, (value || []).length + 1)
    )}">${esc((value || []).join('\n'))}</textarea>${hint}</div>`;
  }

  if (field.type === 'groups') {
    const rows = (value || []).map(settingsGroupRow).join('');
    return `<div class="set-field${changed}" data-set-groups="${name}">
      <span class="set-label">${esc(field.label)}</span>
      <div class="set-group-list">${rows}</div>
      <button type="button" class="secondary set-group-add">Ajouter un groupe</button>${hint}</div>`;
  }

  const type = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text';
  const holder = field.placeholder ? ` placeholder="${escAttr(field.placeholder)}"` : '';
  const shown = field.type === 'password' && values[`${field.name}Set`] ? ' placeholder="inchangé"' : holder;
  return `<div class="set-field${changed}"><label class="set-label" for="${id}">${esc(
    field.label
  )}</label><input type="${type}" id="${id}" data-set="${name}" value="${escAttr(
    value == null ? '' : value
  )}"${shown}>${hint}</div>`;
}

function settingsGroupRow(group) {
  return `<div class="set-group">
    <input type="text" class="set-group-label" value="${escAttr(group.label || '')}" placeholder="Nom du groupe">
    <textarea class="set-group-patterns" rows="${Math.max(
      2,
      (group.patterns || []).length
    )}" placeholder="~/projects/*">${esc((group.patterns || []).join('\n'))}</textarea>
    <button type="button" class="ghost set-group-del" title="Retirer ce groupe">
      <svg class="icon"><use href="#i-trash"/></svg>
    </button>
  </div>`;
}

function renderSettings() {
  const sections = state.settings || {};
  $('#settings-body').innerHTML = SETTINGS_FORM.map((section) => {
    const data = sections[section.key] || { values: {}, overridden: [] };
    const fields = section.fields
      .map((f) => settingsField(section, f, data.values, data.overridden))
      .join('');
    const modified = data.overridden.length
      ? `<span class="set-badge" title="${escAttr(
          `Écarts enregistrés dans data/settings.json : ${data.overridden.join(', ')}`
        )}">modifié</span>`
      : '';
    const reset = data.overridden.length
      ? '<button type="button" class="secondary set-reset">Revenir aux valeurs du dépôt</button>'
      : '';
    const test = section.test
      ? `<button type="button" class="secondary set-test">${esc(section.test)}</button>`
      : '';

    return `<section class="set-card" data-section="${escAttr(section.key)}">
      <div class="set-card-head"><h3>${esc(section.title)}</h3>${modified}</div>
      <p class="set-intro">${esc(section.hint)}</p>
      <div class="set-fields">${fields}</div>
      <div class="set-foot">
        ${reset}${test}
        <button type="button" class="primary set-save">Enregistrer</button>
        <span class="set-result"></span>
      </div>
    </section>`;
  }).join('');
}

/** Relit les champs d'une section dans le DOM. */
function collectSettings(card) {
  const section = SETTINGS_BY_KEY.get(card.dataset.section);
  const out = {};

  for (const field of section.fields) {
    if (field.type === 'checks') {
      const box = card.querySelector(`[data-set-group="${cssEscape(field.name)}"]`);
      out[field.name] = [...box.querySelectorAll('[data-set-item]')]
        .filter((i) => i.checked)
        .map((i) => i.dataset.setItem);
      continue;
    }

    if (field.type === 'groups') {
      out[field.name] = [...card.querySelectorAll('.set-group')].map((row) => ({
        label: row.querySelector('.set-group-label').value,
        patterns: row.querySelector('.set-group-patterns').value.split('\n'),
      }));
      continue;
    }

    const el = card.querySelector(`[data-set="${cssEscape(field.name)}"]`);
    if (!el) continue;
    if (field.type === 'bool') out[field.name] = el.checked;
    else if (field.type === 'lines') out[field.name] = el.value.split('\n');
    else if (field.type === 'number') out[field.name] = Number(el.value);
    else out[field.name] = el.value;
  }
  return out;
}

function settingsResult(section, ok, text) {
  // Retrouvé par sa section et non gardé en référence : `renderSettings` remplace les cartes,
  // et un compte rendu posé sur l'ancienne disparaîtrait sans que l'essai en soit informé.
  const slot = document.querySelector(`.set-card[data-section="${cssEscape(section)}"] .set-result`);
  if (!slot) return;
  slot.textContent = text;
  slot.classList.toggle('bad', !ok);
  slot.classList.toggle('good', ok);
}

$('#settings-body').addEventListener('click', async (e) => {
  const card = e.target.closest('.set-card');
  if (!card) return;

  if (e.target.closest('.set-group-add')) {
    card.querySelector('.set-group-list').insertAdjacentHTML(
      'beforeend',
      settingsGroupRow({ label: '', patterns: [] })
    );
    return;
  }

  const drop = e.target.closest('.set-group-del');
  if (drop) return void drop.closest('.set-group').remove();

  const save = e.target.closest('.set-save');
  const test = e.target.closest('.set-test');
  const reset = e.target.closest('.set-reset');
  if (!save && !test && !reset) return;

  const button = save || test || reset;
  const key = card.dataset.section;
  button.disabled = true;
  settingsResult(key, true, '…');

  try {
    if (reset) {
      const data = await api('DELETE', `/api/settings/${key}`);
      state.settings = data.sections;
      renderSettings();
      if (key === 'groups') loadProjects().catch(() => {});
      return void toast('Valeurs du dépôt rétablies');
    }

    const values = collectSettings(card);

    if (save) {
      const data = await api('POST', `/api/settings/${key}`, values);
      state.settings = data.sections;
      renderSettings();
      // La liste des dossiers de travail vient du serveur : elle doit suivre.
      if (key === 'groups') loadProjects().catch(() => {});
      return void toast('Enregistré');
    }

    // Le test enregistre d'abord : sinon il porterait sur autre chose que ce qui est à
    // l'écran, et un essai concluant ne prouverait rien de la configuration retenue.
    const out = await api('POST', `/api/settings/${key}/test`, { values });
    // On recharge AVANT d'afficher : l'enregistrement fait par le test a changé le repère
    // « modifié », donc les cartes sont repeintes — et le compte rendu doit survivre à ça.
    await loadSettings();
    settingsResult(key, out.ok, out.detail || (out.ok ? 'OK' : 'Échec'));
  } catch (err) {
    settingsResult(key, false, err.message);
  } finally {
    // `renderSettings` a pu remplacer le bouton : ne réactiver que celui qui existe encore.
    if (button.isConnected) button.disabled = false;
  }
});

$('#btn-settings').addEventListener('click', () => {
  showSettings();
  document.body.classList.remove('nav-open');
});
$('#btn-settings-refresh').addEventListener('click', loadSettings);
$('#btn-settings-back').addEventListener('click', () => document.body.classList.add('nav-open'));

// --- Aperçu en grand ------------------------------------------------------

function openLightbox(url, name) {
  $('#lightbox-img').src = url;
  $('#lightbox-name').textContent = name || '';
  $('#lightbox').classList.remove('hidden');
}

function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  $('#lightbox-img').src = '';
}

$('#lightbox').addEventListener('click', (e) => {
  // Clic sur le fond ou sur la croix : on ferme. Clic sur l'image : on garde.
  if (e.target.id !== 'lightbox-img') closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#lightbox').classList.contains('hidden')) closeLightbox();
});

// Une image dont le chemin n'a pas pu être résolu : on le dit, plutôt que de laisser
// une icône cassée. L'événement `error` ne remonte pas, d'où la capture.
$('#messages').addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (!img.classList || !img.classList.contains('msg-img')) return;
    const note = document.createElement('div');
    note.className = 'msg-img-missing';
    note.innerHTML = `<span>⚠</span><span>Image introuvable : <code>${esc(
      img.dataset.path || img.getAttribute('src')
    )}</code></span>`;
    img.replaceWith(note);
  },
  true
);

// Vignettes des messages déjà envoyés
$('#messages').addEventListener('click', (e) => {
  const thumb = e.target.closest('[data-image]');
  if (thumb) {
    openLightbox(thumb.dataset.image, thumb.dataset.name || '');
    return;
  }
  const rewind = e.target.closest('[data-rewind]');
  if (rewind) return askRestore(rewind.dataset.rewind);

  const keep = e.target.closest('[data-memory-keep]');
  const drop = e.target.closest('[data-memory-drop]');
  if (keep || drop) return decideLesson(keep || drop, Boolean(keep));

  const doing = e.target.closest('.idea-do');
  if (doing) return doIdea(doing);

  const idea = e.target.closest('.idea-add');
  if (idea) addIdeaToTodo(idea);
});

/**
 * Lancer une idée tout de suite, sans la retaper.
 *
 * Le message part comme un message ordinaire — donc il rejoint la file si l'agent travaille
 * encore, ce qui est le cas le plus fréquent : on lit la proposition dans un fil dont le turn
 * vient à peine de finir, ou pas encore.
 *
 * `POST /messages` en direct plutôt qu'un passage par `send()` : celui-ci lirait le composeur,
 * emporterait les images en attente, et surtout hériterait du mode objectif s'il est armé —
 * un clic sur « Faire » ne doit pas transformer une idée en boucle de six tours.
 */
async function doIdea(button) {
  const title = button.dataset.ideaTitle;
  const body = button.dataset.ideaBody || '';
  button.disabled = true;
  try {
    await api('POST', `/api/conversations/${state.currentId}/messages`, {
      prompt: `Fais ça.\n\n${title}${body ? `\n${body}` : ''}`,
    });
    button.textContent = 'Envoyé';
  } catch (err) {
    button.disabled = false;
    toastError(err.message);
  }
}

/**
 * Garder ou écarter une leçon proposée.
 *
 * Les deux boutons disparaissent une fois tranché : la décision est prise, et une fiche qu'on
 * peut re-garder dix fois ferait dix lignes dans le prompt.
 */
async function decideLesson(button, keeping) {
  const id = button.dataset.memoryKeep || button.dataset.memoryDrop;
  const zone = button.closest('.msg-notice');
  try {
    const { entry } = await api('POST', `/api/memory/${id}/${keeping ? 'keep' : 'dismiss'}`);
    for (const other of zone.querySelectorAll('.msg-undo')) other.remove();
    zone.querySelector('span').append(
      keeping
        ? ` — gardée${entry.file ? `, écrite dans ${entry.file}` : ''}`
        : ' — écartée'
    );
  } catch (err) {
    toastError(err.message);
  }
}

/**
 * Une idée proposée par l'agent, versée dans la todo du projet.
 *
 * Le projet n'est pas envoyé : le serveur le déduit de la conversation, et c'est lui qui
 * sait qu'une conversation isolée doit alimenter le bloc-notes du dépôt principal.
 */
async function addIdeaToTodo(button) {
  const title = button.dataset.ideaTitle;
  button.disabled = true;
  try {
    await api('POST', '/api/notes', {
      convId: state.currentId,
      title,
      body: button.dataset.ideaBody || '',
    });
    // Le panneau peut être fermé : on recharge quand même, c'est ce qui tient à jour la
    // marque « déjà dans la todo » des autres cartes du fil.
    await loadNotes();
  } catch (err) {
    button.disabled = false;
    toastError(err.message);
  }
}

/**
 * Marque les cartes dont l'idée est déjà dans la todo.
 *
 * Le rapprochement se fait par titre, faute de mieux : la carte est du texte dans un
 * message, elle ne porte pas d'identifiant de ticket et le fil n'est pas réécrit. Le défaut
 * est connu — deux idées au même titre se marquent ensemble —, et il vaut mieux que de
 * reproposer « ajouter » sur une idée déjà ajoutée à chaque rechargement.
 */
function refreshIdeaButtons() {
  const known = new Set((state.notes || []).map((t) => t.title));
  for (const button of document.querySelectorAll('.idea-add')) {
    const already = known.has(button.dataset.ideaTitle);
    button.classList.toggle('added', already);
    button.disabled = already;
    button.textContent = already ? 'Dans la todo' : 'Ajouter à la todo';
  }
}

// --- Restauration de fichiers ---------------------------------------------
//
// Le rewind natif de Claude Code n'existe pas hors de son TUI. Ce bouton ne touche
// donc pas à la conversation : il ramène seulement le dossier de travail à l'état
// qu'il avait avant ce message, depuis l'instantané pris à ce moment-là.

let modalAction = null;

function openModal(title, bodyHtml, okLabel, action, danger) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-ok').textContent = okLabel;
  $('#modal-ok').disabled = !action;
  $('#modal-ok').classList.toggle('hidden', !action);
  // Le même bouton sert à confirmer une opération destructrice et à lancer un agent :
  // sa couleur suit l'usage plutôt que d'être figée dans le HTML.
  $('#modal-ok').classList.toggle('danger', Boolean(danger));
  $('#modal-ok').classList.toggle('primary', !danger);
  modalAction = action;
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  // Fermer la fenêtre de connexion abandonne le flux, quelle que soit la façon de la
  // fermer — bouton, Échap ou clic à côté. Laisser un CLI attendre une autorisation que
  // personne ne donnera ne sert à rien.
  if (loginProvider) {
    const provider = loginProvider;
    loginProvider = null;
    api('DELETE', `/api/accounts/${provider}/login`).catch(() => {});
    refreshAccounts(true);
  }
  $('#modal').classList.add('hidden');
  $('#modal-cancel').textContent = 'Annuler';
  modalAction = null;
}

$('#modal-cancel').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});
$('#modal-ok').addEventListener('click', async () => {
  const action = modalAction;
  if (!action) return;
  $('#modal-ok').disabled = true;
  try {
    await action();
    closeModal();
  } catch (err) {
    const slot = $('#modal-error');
    if (slot) {
      // Formulaire conservé : une erreur de saisie ne doit pas faire perdre ce qui a
      // été rempli. Sans emplacement d'erreur, on retombe sur le remplacement du corps.
      slot.textContent = err.message;
      slot.classList.remove('hidden');
      $('#modal-ok').disabled = false;
      return;
    }
    $('#modal-body').innerHTML = `<div class="modal-warn">${esc(err.message)}</div>`;
    $('#modal-ok').classList.add('hidden');
    modalAction = null;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal();
});

async function askRestore(sha) {
  openModal('Restaurer les fichiers', '<p>Comparaison en cours…</p>', 'Restaurer', null);
  let files;
  try {
    ({ files } = await api(
      'GET',
      `/api/conversations/${state.currentId}/checkpoints/${sha}/diff`
    ));
  } catch (err) {
    openModal('Restauration impossible', `<div class="modal-warn">${esc(err.message)}</div>`, '', null);
    return;
  }

  if (!files.length) {
    openModal(
      'Rien à restaurer',
      '<p>Aucun fichier n\'a changé depuis ce point : le dossier est déjà dans cet état.</p>',
      '',
      null
    );
    return;
  }

  const list = files
    .map(
      (f) =>
        `<li><span class="st-tag st-${esc(f.status)}">${esc(f.label)}</span><span>${esc(f.path)}</span></li>`
    )
    .join('');

  openModal(
    'Restaurer les fichiers',
    `<p>${files.length} fichier(s) ont changé depuis ce point et vont être ramenés à leur état d'avant ce message :</p>
     <ul>${list}</ul>
     <div class="modal-warn">Cette opération écrase le dossier de travail. Un instantané de sécurité est pris juste avant, donc l'opération reste annulable. La conversation, elle, n'est pas modifiée.</div>`,
    'Restaurer les fichiers',
    async () => {
      await api('POST', `/api/conversations/${state.currentId}/checkpoints/${sha}/restore`);
    },
    true
  );
}

// --- Relais ---------------------------------------------------------------
//
// Dériver la conversation ouverte vers un autre agent ou un autre modèle, dans une
// conversation enfant. Le parent n'est pas consommé : on peut le dériver autant de
// fois qu'on veut, ce qui permet de garder un modèle au bon contexte pour concevoir
// et de faire exécuter par d'autres.

const RELAY_PROMPTS = {
  file: 'Reprends le travail décrit dans ce fichier et poursuis-le.',
  conversation: 'Continue le travail engagé dans cette conversation.',
};

function relayCanFork(provider) {
  const forkable = state.models && state.models.forkable;
  // Capacités inconnues — chargement de /api/models en échec : on n'invente pas une
  // incapacité, sinon la fenêtre affirmerait à tort qu'un fournisseur ne sait pas
  // forker. C'est le serveur qui tranche à l'envoi.
  if (!Array.isArray(forkable)) return true;
  return forkable.includes(provider);
}

/** Y a-t-il un contexte à reprendre ? Il faut que le parent ait déjà produit un turn. */
function relayContextAvailable() {
  return Boolean(state.current && state.current.sessionStarted);
}

/**
 * Vers ce fournisseur, la reprise se fait-elle par fork ? Sinon elle passe par une note
 * de passation, qui coûte un turn de plus au parent.
 */
function relayForkPossible(provider) {
  return (
    relayContextAvailable() && provider === state.current.provider && relayCanFork(provider)
  );
}

function relayModelOptions(provider) {
  return modelOptionsHtml(provider);
}

function relayBody(files, warning) {
  const provider = state.current.provider;
  const fileOptions = files.length
    ? files.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')
    : '';

  return `
    <div class="relay-field">
      <span class="relay-label">Point de départ</span>
      <div class="relay-choices">
        <label class="relay-choice">
          <input type="radio" name="relay-from" value="file" checked>
          <span>À partir d'un fichier</span>
        </label>
        <label class="relay-choice">
          <input type="radio" name="relay-from" value="conversation">
          <span>Continuer la conversation</span>
        </label>
      </div>
      <div class="relay-note" id="relay-fork-note"></div>
    </div>

    <div class="relay-field" id="relay-file-field">
      <label class="relay-label" for="relay-file">Fichier</label>
      ${
        fileOptions
          ? `<select id="relay-file">${fileOptions}<option value="__custom__">Autre… (saisie libre)</option></select>`
          : ''
      }
      <input id="relay-file-custom" class="${fileOptions ? 'hidden ' : ''}sub-input"
        placeholder="chemin/relatif/au/dossier.md" autocomplete="off">
      ${
        warning
          ? `<div class="relay-note">${esc(warning)} La saisie libre reste utilisable.</div>`
          : files.length
            ? ''
            : '<div class="relay-note">Aucun markdown créé ou modifié pendant cette conversation.</div>'
      }
    </div>

    <div class="relay-row">
      <div class="relay-field">
        <label class="relay-label" for="relay-provider">Fournisseur</label>
        <select id="relay-provider">
          ${usableProviders()
            .map(
              (p) =>
                `<option value="${p}"${p === provider ? ' selected' : ''}>${
                  esc(PROVIDER_LABELS[p] || p)
                }</option>`
            )
            .join('')}
        </select>
      </div>
      <div class="relay-field">
        <label class="relay-label" for="relay-model">Modèle</label>
        <select id="relay-model">${relayModelOptions(provider)}</select>
      </div>
    </div>

    <div class="relay-field">
      <label class="relay-label" for="relay-prompt">Consigne</label>
      <textarea id="relay-prompt" rows="3">${esc(RELAY_PROMPTS.file)}</textarea>
    </div>

    <div id="modal-error" class="modal-warn hidden"></div>`;
}

function relayFrom() {
  const picked = document.querySelector('input[name="relay-from"]:checked');
  return picked ? picked.value : 'file';
}

/** Reflète l'état des champs après un changement de fournisseur ou de point de départ. */
function syncRelay() {
  const provider = $('#relay-provider').value;
  const from = relayFrom();
  const contextOk = relayContextAvailable();
  const forkOk = relayForkPossible(provider);

  const convRadio = document.querySelector('input[name="relay-from"][value="conversation"]');
  convRadio.disabled = !contextOk;
  convRadio.closest('.relay-choice').classList.toggle('disabled', !contextOk);

  // Rien à reprendre : on rebascule sur le fichier plutôt que de laisser un choix mort.
  if (!contextOk && from === 'conversation') {
    document.querySelector('input[name="relay-from"][value="file"]').checked = true;
  }

  const effective = relayFrom();
  $('#relay-file-field').classList.toggle('hidden', effective !== 'file');

  const note = $('#relay-fork-note');
  if (!contextOk) {
    note.textContent = "Cette conversation n'a encore rien produit à transmettre.";
  } else if (forkOk) {
    note.textContent =
      "L'enfant démarre avec tout le contexte du parent, par fork de sa session. " +
      'Rien à produire, et le parent reste intact.';
  } else {
    note.textContent =
      "Fournisseur différent : le fil ne peut pas voyager. L'agent du parent écrira d'abord " +
      'une note de passation — un turn de plus sur le parent — et l\'enfant démarrera avec elle.';
  }

  const prompt = $('#relay-prompt');
  // On ne réécrit la consigne que si elle est restée l'une des consignes proposées.
  if (Object.values(RELAY_PROMPTS).includes(prompt.value.trim())) {
    prompt.value = RELAY_PROMPTS[effective];
  }
}

function relayFile() {
  const select = $('#relay-file');
  if (!select) return $('#relay-file-custom').value.trim();
  if (select.value === '__custom__') return $('#relay-file-custom').value.trim();
  return select.value;
}

async function askRelay() {
  if (!state.currentId || !state.current) return;

  openModal('Relais', '<p>Recherche des fichiers produits…</p>', '', null);
  let files = [];
  let warning = null;
  try {
    const data = await api('GET', `/api/conversations/${state.currentId}/relay/files`);
    files = data.files || [];
    warning = data.warning || null;
  } catch (err) {
    warning = err.message;
  }

  openModal('Relais', relayBody(files, warning), "Lancer l'enfant", async () => {
    const from = relayFrom();
    const body = {
      from,
      provider: $('#relay-provider').value,
      model: $('#relay-model').value || null,
      prompt: $('#relay-prompt').value.trim(),
    };
    if (from === 'file') {
      body.file = relayFile();
      if (!body.file) throw new Error('Choisis un fichier de départ, ou saisis son chemin.');
    }
    if (!body.prompt) throw new Error('La consigne est vide.');

    // Le relais croisé demande un turn au parent avant de créer l'enfant : ça prend le
    // temps d'un turn, et le bouton doit le dire au lieu de rester muet.
    if (from === 'conversation' && !relayForkPossible(body.provider)) {
      $('#modal-ok').textContent = 'Note de passation en cours…';
    }

    const { conversation } = await api('POST', `/api/conversations/${state.currentId}/relay`, body);
    await refreshList();
    openConv(conversation.id);
  });

  $('#relay-provider').addEventListener('change', () => {
    $('#relay-model').innerHTML = relayModelOptions($('#relay-provider').value);
    syncRelay();
  });
  for (const radio of document.querySelectorAll('input[name="relay-from"]')) {
    radio.addEventListener('change', syncRelay);
  }
  const fileSelect = $('#relay-file');
  if (fileSelect) {
    fileSelect.addEventListener('change', () => {
      const custom = fileSelect.value === '__custom__';
      $('#relay-file-custom').classList.toggle('hidden', !custom);
      if (custom) $('#relay-file-custom').focus();
    });
  }
  syncRelay();
}

$('#btn-relay').addEventListener('click', askRelay);

// --- Dictée « push to talk » ----------------------------------------------
//
// On maintient le bouton, on parle, on relâche : le texte reconnu est inséré dans
// le champ et rien n'est envoyé. L'envoi reste toujours une action explicite.
//
// La reconnaissance vocale exige un contexte sécurisé (https). Servie en http,
// l'app n'en est pas un : on le dit clairement au lieu d'échouer en silence, et
// on renvoie vers la touche micro du clavier, qui fait la même chose.

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = $('#btn-mic');
const micHint = $('#mic-hint');

let recognition = null;
let micHolding = false;
let micFinal = '';

function setMicHint(text, cls) {
  micHint.className = `mic-hint${cls ? ` ${cls}` : ''}${text ? '' : ' hidden'}`;
  micHint.textContent = text || '';
}

function micBlockedReason() {
  if (!window.isSecureContext) {
    return "Le micro du navigateur exige une connexion sécurisée (https), or l'app est servie en http. En attendant : la touche micro de ton clavier dicte dans le champ, sans envoyer.";
  }
  if (!SpeechRec) {
    return 'Ce navigateur ne propose pas la reconnaissance vocale. La touche micro de ton clavier fait la même chose.';
  }
  return null;
}

function insertDictated(text) {
  const clean = text.trim();
  if (!clean) return;
  const box = $('#prompt');
  const sep = box.value && !/\s$/.test(box.value) ? ' ' : '';
  box.value += sep + clean;
  box.dispatchEvent(new Event('input')); // relance l'auto-dimensionnement
}

function stopDictation() {
  micHolding = false;
  micBtn.classList.remove('rec');
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* déjà arrêtée */
    }
  }
}

function startDictation() {
  const blocked = micBlockedReason();
  if (blocked) {
    setMicHint(blocked, 'warn');
    micBtn.classList.add('off');
    return;
  }
  if (micHolding) return;

  micHolding = true;
  micFinal = '';
  micBtn.classList.add('rec');
  setMicHint('Écoute… relâche pour insérer.', 'live');

  recognition = new SpeechRec();
  recognition.lang = navigator.language || 'fr-FR';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) micFinal += `${chunk} `;
      else interim += chunk;
    }
    setMicHint(`${micFinal}${interim}`.trim() || 'Écoute…', 'live');
  };

  recognition.onerror = (event) => {
    const messages = {
      'not-allowed': "Accès au micro refusé. Autorise-le dans les réglages du site.",
      'service-not-allowed': "Le service de reconnaissance vocale est bloqué par le navigateur.",
      'no-speech': 'Rien entendu.',
      network: 'La reconnaissance vocale a besoin du réseau.',
    };
    setMicHint(messages[event.error] || `Erreur de dictée : ${event.error}`, 'warn');
    micHolding = false;
    micBtn.classList.remove('rec');
  };

  recognition.onend = () => {
    // Chrome coupe après un silence : on relance tant que le bouton est maintenu.
    if (micHolding) {
      try {
        recognition.start();
        return;
      } catch {
        /* on retombe sur l'insertion */
      }
    }
    micBtn.classList.remove('rec');
    insertDictated(micFinal);
    setMicHint(micFinal.trim() ? 'Texte inséré — relis avant d\'envoyer.' : '');
    if (micFinal.trim()) setTimeout(() => setMicHint(''), 4000);
    recognition = null;
  };

  try {
    recognition.start();
  } catch (err) {
    setMicHint(`Impossible de démarrer la dictée : ${err.message}`, 'warn');
    stopDictation();
  }
}

micBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  startDictation();
});
micBtn.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('pointerup', () => {
  if (micHolding) stopDictation();
});
window.addEventListener('pointercancel', () => {
  if (micHolding) stopDictation();
});

// Pas de bouton mort : en http (contexte non sécurisé) ou sans API de
// reconnaissance vocale, la dictée est impossible, donc le bouton n'existe pas.
// Il réapparaîtra de lui-même le jour où l'app sera servie en https.
if (micBlockedReason()) {
  micBtn.remove();
  console.info(`Dictée indisponible : ${micBlockedReason()}`);
}

// --- Websocket ------------------------------------------------------------

let ws;
let retry = 0;

/**
 * Annonce ce que cet onglet regarde. C'est la seule chose que le navigateur envoie sur le
 * websocket, et elle ne sert qu'à une décision : sonner le téléphone, ou laisser une minute
 * à celui qui a déjà la conversation sous les yeux.
 *
 * « Regarder » veut dire les trois à la fois : une conversation ouverte, la vue affichée, et
 * l'onglet au premier plan. Un onglet en arrière-plan sur la bonne conversation ne verra pas
 * plus la question qu'un écran éteint.
 */
function sendPresence() {
  if (!ws || ws.readyState !== 1) return;
  const onConv = state.currentId && !$('#conv-view').classList.contains('hidden');
  ws.send(
    JSON.stringify({
      type: 'presence',
      convId: onConv ? state.currentId : null,
      visible: document.visibilityState === 'visible',
    })
  );
}

// Battement deux fois plus rapide que la péremption côté serveur : un onglet bien vivant ne
// doit jamais être compté absent parce qu'un message s'est perdu.
setInterval(sendPresence, 40_000);
document.addEventListener('visibilitychange', sendPresence);

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

  ws.onopen = () => {
    retry = 0;
    refreshList();
  };

  ws.onclose = () => {
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, retry * 800);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const mine = msg.convId && msg.convId === state.currentId;

    switch (msg.type) {
      case 'hello':
        // Une demande peut etre arrivee pendant que le telephone etait ferme. La plus
        // ancienne reprend la main des la reconnexion, comme si son websocket venait juste
        // de la publier.
        if (msg.authRequests && msg.authRequests.length && !googleOauthModalOpen) {
          openAuthRequestModal(msg.authRequests[0]);
        }
        // Le serveur donne l'état complet à la connexion : c'est ce qui rétablit le badge
        // après un rechargement, ou sur un second appareil qui arrive en cours de route.
        state.pendingAsks = msg.asks || [];
        state.silent = msg.silent || [];
        renderAskBadge();
        sendPresence();
        break;

      // Un turn qui n'écrit plus rien. Rien n'est interrompu ici : le serveur signale, et
      // c'est le bouton ■ déjà présent qui tranche.
      // Une règle changée ailleurs — ou par un agent — pendant que la modale est ouverte.
      case 'rules':
        if (rulesProject && msg.project === rulesProject) {
          state.rules = msg.rules || [];
          renderRules(state.rules);
        }
        break;

      // Un modèle enregistré depuis un autre appareil doit apparaître ici aussi.
      case 'prompts':
        state.prompts = msg.prompts || [];
        break;

      case 'silent':
        state.silent = msg.turns || [];
        renderList();
        if (state.current) renderHead();
        break;

      case 'item':
        if (mine) {
          clearStreams();
          state.current.items.push(msg.item);
          const html = renderItem(msg.item);
          if (html) {
            const wrap = document.createElement('div');
            wrap.innerHTML = html;
            const stick = atBottom();
            // `is-new` déclenche l'animation d'apparition : seulement sur les
            // éléments qui arrivent en direct, pas au rendu complet du fil.
            const nodes = [...wrap.children];
            nodes.forEach((n) => n.classList.add('is-new'));
            $('#messages').append(...wrap.childNodes);
            scrollDown(stick);
          }
        }
        // Un item ne change de la liste que l'ordre de fraîcheur : rien qui vaille un
        // aller-retour réseau par message reçu.
        scheduleListRefresh();
        break;

      case 'itemUpdate':
        if (mine) {
          const idx = state.current.items.findIndex((it) => it.id === msg.item.id);
          if (idx !== -1) state.current.items[idx] = msg.item;
          // Vaut pour un outil dont le résultat arrive comme pour un avis repeint
          // en erreur quand le turn a finalement échoué.
          const node = document.querySelector(`[data-item="${msg.item.id}"]`);
          if (node) {
            const wasOpen = node.open;
            const wrap = document.createElement('div');
            wrap.innerHTML = renderItem(msg.item);
            const fresh = wrap.firstElementChild;
            if (fresh) {
              if (wasOpen !== undefined && 'open' in fresh) fresh.open = wasOpen;
              node.replaceWith(fresh);
            }
          }
        }
        break;

      case 'delta':
        if (mine) {
          const el = streamEl(msg.kind);
          el.dataset.raw += msg.text;
          const stick = atBottom();
          el.innerHTML =
            msg.kind === 'thinking'
              ? `${esc(el.dataset.raw)}<span class="caret"></span>`
              : `${md(el.dataset.raw)}<span class="caret"></span>`;
          scrollDown(stick);
        }
        break;

      case 'status':
        if (mine) {
          state.current.status = msg.status;
          setRunning(msg.status === 'working');
          renderHead();
        }
        // La pastille doit changer tout de suite, y compris pour une conversation qui n'est
        // pas celle affichée : c'est le seul signe qu'un agent lancé ailleurs travaille.
        {
          const row = state.convs.find((c) => c.id === msg.convId);
          if (row && row.status !== msg.status) {
            row.status = msg.status;
            renderList();
          }
        }
        scheduleListRefresh();
        if (msg.status !== 'working') {
          // Un turn qui s'achève vient de consommer du quota et d'écrire dans le
          // journal de consommation.
          renderLimits(true);
          if (!$('#usage-view').classList.contains('hidden')) showUsage();
        }
        break;

      case 'metrics':
        if (mine) {
          if (msg.totalCostUsd != null) state.current.totalCostUsd = msg.totalCostUsd;
          if (msg.contextTokens != null) state.current.contextTokens = msg.contextTokens;
          if (msg.contextWindow != null) state.current.contextWindow = msg.contextWindow;
          if (msg.lastModels != null) state.current.lastModels = msg.lastModels;
          renderHead();
          renderPromptModel();
        }
        break;

      // La boucle d'objectif avance seule : le bandeau doit suivre sans qu'on ait rien demandé.
      case 'goal':
        if (mine) {
          state.current.goal = msg.goal;
          renderGoalLive();
        }
        break;

      case 'queue':
        if (mine) {
          state.queue = msg.queue;
          if (!state.queue.some((q) => q.id === editingQueueId)) editingQueueId = null;
          renderQueue();
        }
        break;

      case 'folders':
        if (msg.folders) state.folders = msg.folders;
        renderList();
        break;

      // Le planificateur écrit sans que personne n'ait cliqué : la vue doit suivre, mais
      // seulement si elle est ouverte — sinon on recharge la liste pour rien.
      case 'triggers':
        if (msg.triggers && !$('#triggers-view').classList.contains('hidden')) {
          showTriggers();
        }
        break;

      // La connexion avance côté serveur — le CLI attend, puis aboutit — sans que le
      // navigateur ait rien demandé.
      case 'login':
        renderLoginModal(msg.provider, msg.login);
        break;

      case 'remote-browser':
        if (!$('#connections-view').classList.contains('hidden')) {
          renderRemoteBrowser(msg.browser);
        }
        break;

      case 'auth-request':
        // Intervention bloquante : le bon site s'ouvre directement au-dessus de la vue
        // courante. Pas de detour par Connexions, ni de second clic.
        openAuthRequestModal(msg.request);
        break;

      case 'auth-request-resolved':
        if (!$('#connections-view').classList.contains('hidden')) loadConnections();
        break;

      // Un agent vient de poser une question. Le bandeau n'est monté que sur la conversation
      // concernée : les autres l'apprendront en s'ouvrant, via `pendingFor`.
      case 'ask':
        if (!msg.ask) break;
        trackAsk(msg.ask, false);
        if (msg.ask.convId === state.currentId) {
          state.ask = msg.ask;
          renderAskPending();
        }
        break;

      // Un ticket a bougé — depuis l'interface, un autre appareil, ou un agent qui vient
      // de passer le sien en « fait ». Repeint seulement si c'est bien ce projet-là.
      case 'notes':
        if (msg.project && msg.project === state.notesProject) {
          state.notes = msg.tickets || [];
          renderNotes();
        }
        break;

      // Un plan a été écrit — depuis l'interface, un autre onglet, ou un agent qui vient de
      // mettre son plan à jour. Le tiroir décide seul s'il doit se repeindre : il ne le fait
      // pas sous une édition en cours.
      case 'plans':
        if (window.plansPanel) window.plansPanel.onServerChange(msg.project);
        break;

      // Répondu ici ou depuis un autre appareil, ou expiré faute de réponse : dans tous les
      // cas la question tombe, et le badge de l'onglet avec elle.
      case 'ask-answered':
        if (!msg.ask) break;
        trackAsk(msg.ask, true);
        if (msg.ask.convId === state.currentId) {
          state.ask = null;
          renderAskPending();
        }
        break;

      case 'google-accounts':
        if (!$('#connections-view').classList.contains('hidden')) renderGoogle(msg.google);
        if (googleOauthModalOpen && connectionModalMode === 'google') {
          closeGoogleOauthModal(true, false);
        }
        break;

      // Un message planifié est parti, ou a été annulé ailleurs. La modale n'est rafraîchie
      // que si elle est ouverte : sinon il n'y a rien à mettre à jour.
      case 'planned':
        if (!$('#plan-modal').classList.contains('hidden')) {
          api('GET', '/api/planned')
            .then((d) => renderPlanList((d.planned || []).filter((p) => p.convId === state.currentId)))
            .catch(() => {});
        }
        break;

      // Le catalogue a changé : un plugin installé, une skill créée. On le rechargera à la
      // prochaine ouverture de conversation.
      case 'skills':
        state.skillsOf = null;
        if (state.current) loadSkills(state.current.provider);
        break;

      // L'atelier travaille. Le direct n'est pas persisté — c'est du flux, comme le streaming
      // d'une conversation — donc rien à faire quand la vue n'est pas ouverte : `loadAtelier`
      // reprendra le fil, qui est côté serveur.
      case 'atelier': {
        if ($('#skills-view').classList.contains('hidden')) break;
        if (msg.phase === 'start') {
          renderAtelierLog(msg.messages);
          setAtelierBusy(true);
          renderAtelierLive(ATELIER_START);
        } else if (msg.phase === 'delta') {
          if (msg.kind !== 'thinking') appendAtelierLive(msg.text);
        } else if (msg.phase === 'tool') {
          const arg = summarizeInput(msg);
          appendAtelierLive(`\n→ ${msg.tool}${arg ? ` ${arg.slice(0, 120)}` : ''}\n`);
        } else {
          renderAtelierLog(msg.messages);
          setAtelierBusy(false);
          if (msg.phase === 'end') loadSkillsView();
        }
        break;
      }

      case 'gallery':
        if (!$('#gallery-view').classList.contains('hidden')) loadGalleryImages();
        break;

      case 'gallery-projects':
        if (!$('#gallery-view').classList.contains('hidden')) showGallery();
        break;

      case 'account':
        if (msg.account && state.accounts) {
          state.accounts[msg.provider] = msg.account;
          renderAccounts();
          renderFilters();
          renderNoProvider();
          renderProviderPick('#provider-pick', state.provider);
        }
        break;

      case 'conversation':
      case 'deleted':
        // Le titre peut changer sans que personne n'ait cliqué : le modèle nomme la
        // conversation quelques secondes après son premier message. L'en-tête doit suivre,
        // sinon il garde « Nouvelle conversation » sous les yeux de qui regarde.
        if (msg.conversation && msg.conversation.id === state.currentId && state.current) {
          state.current.title = msg.conversation.title;
          renderHead();
        }
        refreshList();
        if (msg.type === 'deleted' && msg.convId === state.currentId) showNew();
        // Le second volet montrait cette conversation : le laisser ouvert afficherait l'écran
        // de création dans un volet qu'on n'a pas demandé. Jamais depuis le volet lui-même :
        // il partage ce `localStorage` et effacerait la préférence de la page principale.
        if (!SOLO && msg.type === 'deleted' && PREFS.read('paneB', null) === msg.convId) {
          closePaneB();
        }
        break;
    }

  };
}

// --- Amorçage -------------------------------------------------------------

(async function init() {
  connect();

  try {
    state.models = await api('GET', '/api/models');
  } catch {
    state.models = null;
  }
  renderModels();

  try {
    await loadProjects();
  } catch (err) {
    $('#new-error').textContent = `Liste des dossiers indisponible : ${err.message}`;
  }

  await refreshAccounts();

  renderLimits();
  setInterval(() => renderLimits(), 120_000);
  setInterval(refreshResetTitles, 30_000);

  await refreshList();

  // Mode « volet seul » : la page tourne dans l'iframe de droite. Une seule conversation, et
  // rien autour — la barre latérale et le second volet sont masqués par la classe `solo`.
  if (SOLO) {
    document.body.classList.add('solo');
    try {
      await openConv(SOLO);
    } catch {
      // Conversation supprimée entre l'ouverture du volet et son chargement. Mieux vaut le
      // dire que laisser l'écran de création apparaître dans un volet qu'on n'a pas demandé.
      $('#main').innerHTML = '<div class="empty">Cette conversation n’existe plus.</div>';
    }
    return;
  }

  const savedWidth = PREFS.read('paneWidth', null);
  if (savedWidth) setPaneWidth(savedWidth);

  // Le second volet est rouvert tel qu'il était — mais seulement si sa conversation existe
  // encore : rouvrir un iframe sur une conversation supprimée afficherait une erreur, alors
  // qu'il suffit de refermer le volet.
  const savedPane = PREFS.read('paneB', null);
  if (savedPane && state.convs.some((c) => c.id === savedPane)) openPaneB(savedPane);
  else if (savedPane) PREFS.write('paneB', null);

  if (state.convs.length) openConv(state.convs[0].id);
  else showNew();
})();
