'use strict';

// L'atelier des skills : un chat qui écrit et modifie les skills à ta place.
//
// L'onglet Skills savait déplacer, supprimer et créer par formulaire. Écrire une skill restait
// donc à faire soi-même — dans un champ, en respectant un frontmatter YAML dont une erreur rend
// la skill invisible sans rien dire. Et *modifier* une skill existante n'était pas possible du
// tout : il fallait ouvrir le fichier à la main, dans un terminal.
//
// Ce chat comble ça, et il le fait en laissant l'agent travailler.
//
// Pourquoi l'agent écrit les fichiers lui-même, plutôt que de nous renvoyer un objet à
// appliquer. Une skill n'est pas seulement un texte : elle peut restreindre ses outils,
// s'appuyer sur des fichiers annexes (`references/`, scripts), ne charger ses détails qu'au
// besoin. Un protocole « rends-moi {nom, description, corps} » ramènerait tout ça à un
// copier-coller de paragraphe, et rendrait impossible la seule chose qu'on veut vraiment :
// « relis /commit-work et ajoute-lui une étape de vérification ». L'agent, lui, sait lire le
// fichier avant de l'écrire.
//
// Ce qui reste à ce module : dire à l'agent où sont les dossiers, quelle forme a un SKILL.md, et
// ce qu'il ne doit pas toucher — puis se souvenir de la conversation, pour que « non, plutôt
// comme ça » veuille dire quelque chose.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'skills-chat.json');

/**
 * Identifiant du chat, côté fichiers de flux (`data/turns/<id>.jsonl`) et journal de
 * consommation. Stable et unique : il n'y a qu'un atelier, et un seul turn à la fois dedans.
 */
const ID = 'atelier-skills';

/**
 * Échanges gardés dans le prompt. La session du CLI porte déjà le contexte quand elle est
 * reprise ; ce rappel sert aux fournisseurs dont la session repart de zéro, et après un
 * redémarrage. Six échanges suffisent à comprendre « non, plutôt comme ça » sans faire grossir
 * le prompt à chaque tour.
 */
const RECALL = 6;

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return { messages: [] };
    return { ...raw, messages: Array.isArray(raw.messages) ? raw.messages : [] };
  } catch {
    return { messages: [] };
  }
}

function write(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

/** Le chat tel que l'interface le montre. */
function state() {
  const data = read();
  return {
    messages: data.messages,
    provider: data.provider || null,
    sessionStarted: Boolean(data.sessionStarted && data.providerSessionId),
  };
}

/**
 * Ajoute un message au fil du chat.
 *
 * Le fil est borné à cent messages : c'est un atelier, pas une archive, et le fichier est relu
 * en entier à chaque tour.
 */
function remember(role, text) {
  const data = read();
  data.messages = [...data.messages, { role, text: String(text || ''), at: new Date().toISOString() }].slice(-100);
  write(data);
  return data.messages;
}

/** Session du CLI, pour que le tour suivant reprenne le contexte au lieu de repartir de zéro. */
function session() {
  const data = read();
  return {
    provider: data.provider || null,
    providerSessionId: data.providerSessionId || null,
    sessionStarted: Boolean(data.sessionStarted && data.providerSessionId),
  };
}

/**
 * Retient la session ouverte par le CLI.
 *
 * Elle est rangée **par fournisseur** : reprendre chez Codex une session ouverte par Claude
 * échouerait, et changer de fournisseur en cours de chat est justement une chose qu'on fait —
 * une skill écrite par l'un se relit chez l'autre.
 */
function keepSession(provider, providerSessionId) {
  write({
    ...read(),
    provider,
    providerSessionId: providerSessionId || null,
    sessionStarted: Boolean(providerSessionId),
  });
}

/**
 * Session à reprendre pour ce fournisseur, s'il y en a une.
 *
 * Rien à reprendre quand le fournisseur a changé : un identifiant de session ouvert par Claude
 * ne veut rien dire pour Codex, et le turn échouerait au lancement. Le fil du chat, lui, est
 * conservé — c'est le rappel dans le prompt qui fait la continuité.
 */
function resumable(provider) {
  const known = session();
  if (!known.sessionStarted || known.provider !== provider) return null;
  return known.providerSessionId;
}

/** Oublie tout : le fil et la session. Le disque, lui, garde les skills écrites. */
function reset() {
  write({ messages: [] });
  return state();
}

/**
 * Consigne de l'atelier.
 *
 * Elle dit trois choses, et chacune répare une façon de se tromper qu'un agent a réellement :
 *
 *   - **où** écrire. Sans les chemins, l'agent invente `./skills/` dans le dossier courant, et
 *     la skill n'est chargée par personne.
 *   - **la forme** du fichier. Le frontmatter est ce que les CLIs lisent ; une description
 *     manquante ou étalée sur plusieurs lignes non indentées rend la skill invisible, sans
 *     erreur.
 *   - **ce qu'il ne doit pas toucher** : les skills de plugins, qui seront remplacées à la
 *     prochaine mise à jour du plugin, et le reste du dépôt.
 *
 * @param {object} spec
 * @param {string} spec.message la demande
 * @param {object} spec.inventory ce que `skills.inventory()` a rendu
 * @param {Array<{role: string, text: string}>} [spec.messages] échanges précédents
 */
function buildPrompt({ message, inventory, messages }) {
  const inv = inventory || {};
  const editable = (inv.skills || []).filter((s) => s.editable);

  const lines = [
    "Tu es dans l'atelier des skills d'agentHub. On te demande d'écrire, de modifier, de " +
      'renommer ou de supprimer des skills — les commandes en « / » que les CLIs déroulent.',
    '',
    'Où vivent les fichiers :',
    `- portée globale (tous les projets) : ${inv.globalRoot}/<nom>/SKILL.md`,
  ];
  lines.push(
    inv.projectRoot
      ? `- portée projet (${inv.cwd}) : ${inv.projectRoot}/<nom>/SKILL.md`
      : "- portée projet : aucun projet choisi dans l'interface, travaille en portée globale"
  );

  lines.push(
    '',
    "Forme d'un SKILL.md, à respecter exactement — c'est ce frontmatter que les CLIs lisent, et",
    "une erreur dedans rend la skill invisible sans le moindre message d'erreur :",
    '',
    '---',
    'name: nom-en-minuscules-avec-tirets',
    'description: une seule ligne, qui dit quand se servir de cette skill',
    '---',
    '',
    '# Titre',
    '',
    '## Marche à suivre',
    '1. …',
    '',
    'Le nom du dossier doit être identique au `name` du frontmatter : minuscules, chiffres et',
    'tirets. La description tient sur une seule ligne.',
    '',
    'Règles :',
    "- Écris directement les fichiers, avec tes outils. C'est ce qu'on attend de toi : personne",
    '  ne recopiera ta réponse à la main.',
    '- Ne touche à rien d’autre que ces dossiers de skills. Pas de commit, pas de dépôt.',
    "- Les skills fournies par un plugin ne sont pas modifiables : elles seront remplacées à la",
    '  prochaine mise à jour du plugin. Si on te demande de partir de l’une d’elles, recopie-la',
    '  sous un nouveau nom en portée globale.',
    '- Avant de modifier une skill existante, relis son fichier. Ne réécris pas de mémoire.',
    '- Termine par deux ou trois lignes en français : ce que tu as fait, et le nom des skills',
    '  touchées. Pas de récapitulatif long, l’interface affiche déjà la liste.',
    ''
  );

  if (editable.length) {
    lines.push(
      `Skills modifiables aujourd'hui (${editable.length}) :`,
      ...editable.map(
        (s) => `- /${s.name} [${s.scope}]${s.description ? ` — ${s.description}` : ''}`
      ),
      ''
    );
  } else {
    lines.push("Aucune skill à toi pour l'instant : tout ce qui existe vient de plugins.", '');
  }

  const earlier = (messages || []).slice(-RECALL);
  if (earlier.length) {
    lines.push(
      'Ce qui a déjà été dit dans cet atelier (le plus ancien en premier) :',
      ...earlier.map((m) => `${m.role === 'user' ? 'Demande' : 'Toi'} : ${m.text.slice(0, 800)}`),
      ''
    );
  }

  lines.push('La demande :', String(message || '').trim());
  return lines.join('\n');
}

module.exports = {
  ID,
  RECALL,
  FILE,
  state,
  remember,
  session,
  resumable,
  keepSession,
  reset,
  buildPrompt,
};
