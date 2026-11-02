'use strict';

// Catalogue des skills — les commandes en « / » que les CLIs savent recevoir.
//
// Le point de départ de tout ce module : **les skills marchent déjà**. Mesuré le
// 03/08/2026 en envoyant `/compound-engineering:ce-commit` sur stdin à `claude --print` :
// l'agent a suivi le mode opératoire de la skill (git status, diff, branche, log, remote
// HEAD), il ne l'a pas lu comme du texte. agentHub s'appuie d'ailleurs déjà là-dessus pour
// relever les quotas avec `/usage`.
//
// Il n'y a donc rien à exécuter ici, et surtout rien à réimplémenter. Ce qui manquait,
// c'est de **savoir ce qui existe** : sans liste, il faut connaître le nom par cœur pour
// s'en servir. Ce module tient cette liste.
//
// D'où viennent les noms : de l'événement `init` du CLI lui-même, qui publie ses
// `slash_commands` — 76 chez Claude sur cette installation, plugins compris. C'est la seule
// source qui ne mente pas, puisque c'est celle du programme qui les accepte. Le prix à
// payer est qu'elle n'arrive qu'au premier turn d'un fournisseur ; le catalogue est donc
// persisté pour survivre aux redémarrages.
//
// D'où viennent les descriptions : des fichiers `SKILL.md`, dont le frontmatter en porte
// une. Le CLI ne les publie pas. La résolution est en meilleur effort — un nom sans
// description reste utilisable, il est juste moins parlant.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const CATALOGUE = path.join(DATA_DIR, 'skills.json');

/**
 * Commandes qui n'ont rien à faire dans une autocomplétion.
 *
 * Certaines appartiennent au TUI et ne veulent rien dire en headless (`/clear`, `/exit`),
 * d'autres sont des réglages de session qu'agentHub gère par son interface (`/model`,
 * `/effort`). Les proposer serait inviter à casser quelque chose.
 */
const HIDDEN = new Set([
  'clear',
  'exit',
  'quit',
  'help',
  'login',
  'logout',
  'model',
  'effort',
  'resume',
  'config',
  'status',
  'terminal-setup',
  'vim',
  'theme',
  'always-approve',
  'plugins',
  'reload-plugins',
]);

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function write(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CATALOGUE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, CATALOGUE);
}

/**
 * Enregistre ce qu'un événement `init` a publié.
 *
 * N'écrit que si la liste a changé : un turn par minute ne doit pas réécrire un fichier
 * pour rien. Renvoie `true` quand quelque chose a bougé, pour que l'appelant prévienne
 * l'interface.
 */
function remember(provider, { commands, plugins }) {
  if (!provider || !Array.isArray(commands) || !commands.length) return false;

  const all = read();
  const known = all[provider] || {};
  const sorted = [...new Set(commands.map(String))].sort();
  const paths = (plugins || [])
    .map((p) => (p && typeof p === 'object' ? p.path : null))
    .filter(Boolean)
    .sort();

  const same =
    JSON.stringify(known.commands || []) === JSON.stringify(sorted) &&
    JSON.stringify(known.pluginPaths || []) === JSON.stringify(paths);
  if (same) return false;

  all[provider] = { commands: sorted, pluginPaths: paths, seenAt: new Date().toISOString() };
  write(all);
  return true;
}

/** Premier titre markdown d'un texte, sans ses dièses. */
function firstHeading(text) {
  const found = /^#{1,3}\s+(.+?)\s*$/m.exec(String(text || ''));
  return found ? found[1].trim().slice(0, 400) : null;
}

/**
 * Description d'un SKILL.md. Du frontmatter quand il y en a, sinon du titre.
 *
 * Le frontmatter est la forme documentée, mais une bonne partie des skills réelles n'en ont
 * pas : elles commencent par leur titre. Renvoyer `null` pour celles-là rendait
 * l'autocomplétion muette sur la moitié du catalogue, alors que le titre dit déjà
 * l'essentiel.
 */
function describeFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  // Frontmatter délimité par --- en tête de fichier.
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!front) return firstHeading(raw);
  // `description:` peut tenir sur plusieurs lignes en YAML replié ; on prend jusqu'à la
  // prochaine clé de premier niveau.
  const found = /^description:\s*(?:>[-+]?|\|[-+]?)?\s*([\s\S]*?)(?=\r?\n[a-zA-Z_-]+:|$)/m.exec(
    front[1]
  );
  // Frontmatter présent mais sans description : le titre reste mieux que rien.
  if (!found) return firstHeading(raw.slice(front[0].length));
  return found[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/^["']|["']$/g, '')
    .slice(0, 400);
}

/**
 * Endroits où chercher le `SKILL.md` d'un nom donné.
 *
 * Un nom peut être préfixé de son plugin (`compound-engineering:ce-commit`) : le fichier,
 * lui, est rangé sous le nom court dans le dossier du plugin. Les chemins de plugins
 * viennent de l'événement `init`, donc on ne les devine pas.
 */
function candidates(name, pluginPaths) {
  const bare = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  const home = os.homedir();
  const out = [];

  for (const root of pluginPaths || []) {
    out.push(path.join(root, 'skills', bare, 'SKILL.md'));
    out.push(path.join(root, 'commands', `${bare}.md`));
  }
  out.push(path.join(home, '.claude', 'skills', bare, 'SKILL.md'));
  out.push(path.join(home, '.claude', 'commands', `${bare}.md`));
  out.push(path.join(home, '.codex', 'prompts', `${bare}.md`));
  out.push(path.join(home, '.grok', 'skills', bare, 'SKILL.md'));
  return out;
}

/** Cache des descriptions : lire cinquante frontmatters à chaque affichage est inutile. */
let described = null;

function describe(name, pluginPaths) {
  if (!described) described = new Map();
  if (described.has(name)) return described.get(name);
  let text = null;
  for (const file of candidates(name, pluginPaths)) {
    text = describeFile(file);
    if (text) break;
  }
  described.set(name, text);
  return text;
}

/**
 * Catalogue d'un fournisseur, prêt pour l'interface.
 *
 * @returns {{provider: string, seenAt: string|null, skills: Array<{name: string,
 *   group: string|null, description: string|null}>}}
 */
function list(provider) {
  const known = read()[provider];
  if (!known || !Array.isArray(known.commands)) {
    return { provider, seenAt: null, skills: [] };
  }
  const skills = known.commands
    .filter((name) => !HIDDEN.has(name))
    .map((name) => ({
      name,
      // Le préfixe avant « : » est le plugin d'origine : c'est le regroupement naturel.
      group: name.includes(':') ? name.slice(0, name.indexOf(':')) : null,
      description: describe(name, known.pluginPaths),
    }));
  return { provider, seenAt: known.seenAt || null, skills };
}

/** Oublie les descriptions en cache, après l'ajout ou la modification d'une skill. */
function forgetDescriptions() {
  described = null;
}

// --- Portées : global ou projet ---------------------------------------------
//
// Ce découpage n'est pas une invention d'agentHub, c'est celui des CLIs eux-mêmes :
//
//   ~/.claude/skills/<nom>/SKILL.md          → disponible dans TOUS les projets
//   <projet>/.claude/skills/<nom>/SKILL.md   → disponible dans ce projet seulement
//
// Déplacer une skill d'une portée à l'autre est donc littéralement déplacer son dossier.
// Rien à enregistrer ailleurs, rien qui puisse se désynchroniser — et une skill installée
// hors d'agentHub apparaît quand même, puisque c'est le disque qui fait foi.
//
// Les skills de plugins sont en lecture seule : elles appartiennent au plugin, qui les
// remplacera à sa prochaine mise à jour.

/** Un nom de skill est aussi un nom de dossier : on borne ce qu'on accepte d'écrire. */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/;

function globalRoot() {
  return path.join(os.homedir(), '.claude', 'skills');
}

function projectRoot(cwd) {
  return cwd ? path.join(cwd, '.claude', 'skills') : null;
}

function readRoot(root, scope) {
  if (!root) return [];
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    out.push({ name: entry.name, scope, description: describeFile(file), editable: true });
  }
  return out;
}

/**
 * Ce qui est sur disque, avec sa portée. Sert l'onglet de gestion, là où `list()` sert
 * l'autocomplétion — les deux répondent à des questions différentes : « qu'est-ce que je
 * peux taper » et « qu'est-ce que je peux déplacer ».
 *
 * @param {string} [cwd] dossier de travail, pour la portée projet
 */
function inventory(cwd) {
  const globals = readRoot(globalRoot(), 'global');
  const project = readRoot(projectRoot(cwd), 'project');

  // Une skill du projet masque son homonyme global : c'est ainsi que les CLIs résolvent,
  // et le dire évite de croire qu'on a deux fois la même.
  const shadowed = new Set(project.map((s) => s.name));
  for (const s of globals) if (shadowed.has(s.name)) s.shadowed = true;

  return {
    cwd: cwd || null,
    globalRoot: globalRoot(),
    projectRoot: projectRoot(cwd),
    skills: [...project, ...globals].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function dirOf(name, scope, cwd) {
  const root = scope === 'project' ? projectRoot(cwd) : globalRoot();
  return root ? path.join(root, name) : null;
}

/**
 * Déplace une skill d'une portée à l'autre.
 * @returns {{error: string}|{name: string, scope: string}}
 */
function move(name, from, to, cwd) {
  if (!SKILL_NAME_RE.test(name)) return { error: `Nom de skill invalide : ${name}` };
  if (from === to) return { error: 'Même portée : rien à déplacer.' };
  if ((from === 'project' || to === 'project') && !cwd) {
    return { error: 'La portée projet demande un dossier de travail.' };
  }

  const src = dirOf(name, from, cwd);
  const dest = dirOf(name, to, cwd);
  if (!src || !fs.existsSync(src)) return { error: `Skill introuvable en portée ${from}.` };
  if (fs.existsSync(dest)) return { error: `Une skill « ${name} » existe déjà en portée ${to}.` };

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch {
    // Portées sur des systèmes de fichiers différents : rename échoue, on recopie.
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
  forgetDescriptions();
  return { name, scope: to };
}

/**
 * Crée une skill. Le corps est le mode opératoire en markdown ; le frontmatter est écrit
 * par nous, parce que c'est lui que les CLIs lisent et qu'une erreur dedans rend la skill
 * invisible sans rien dire.
 */
function create({ name, description, body, scope, cwd }) {
  const key = String(name || '').trim().toLowerCase();
  if (!SKILL_NAME_RE.test(key)) {
    return {
      error:
        `Nom invalide : « ${name} ». Minuscules, chiffres et tirets, ` +
        "entre 2 et 60 caractères — c'est aussi un nom de dossier.",
    };
  }
  const desc = String(description || '').trim();
  if (!desc) return { error: 'Une description est nécessaire : c’est elle qui dit quand s’en servir.' };
  const text = String(body || '').trim();
  if (!text) return { error: 'Une skill vide ne fait rien : décris le mode opératoire.' };

  const dir = dirOf(key, scope === 'project' ? 'project' : 'global', cwd);
  if (!dir) return { error: 'La portée projet demande un dossier de travail.' };
  if (fs.existsSync(dir)) return { error: `« ${key} » existe déjà dans cette portée.` };

  fs.mkdirSync(dir, { recursive: true });
  // Description sur une seule ligne : un retour à la ligne non indenté casserait le YAML.
  const front = `---\nname: ${key}\ndescription: ${desc.replace(/\s+/g, ' ')}\n---\n\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `${front}${text}\n`);
  forgetDescriptions();
  return { name: key, scope: scope === 'project' ? 'project' : 'global' };
}

/** Supprime une skill. Une skill de plugin n'est pas concernée : elle n'est pas ici. */
function remove(name, scope, cwd) {
  if (!SKILL_NAME_RE.test(name)) return { error: `Nom de skill invalide : ${name}` };
  const dir = dirOf(name, scope, cwd);
  if (!dir || !fs.existsSync(dir)) return { error: 'Skill introuvable.' };
  fs.rmSync(dir, { recursive: true, force: true });
  forgetDescriptions();
  return { removed: name };
}

// --- Fournisseurs qui ne savent pas dérouler une skill eux-mêmes ------------
//
// Claude et Grok lisent tous les deux `~/.claude/skills/` et déroulent `/nom` envoyé sur
// stdin : mesuré le 03/08/2026, `/compound-engineering:ce-commit` a bien suivi le mode
// opératoire de la skill, et les 16 skills globales apparaissent dans les 80
// `slash_commands` de Grok. Rien à synchroniser entre ces deux-là, ils partagent le dossier.
//
// Codex, non. Ses prompts personnalisés (`~/.codex/prompts/`) sont une fonction de son TUI :
// en `codex exec`, `/agenthub-sonde` lui a valu « I don't recognize this command ». Mesuré
// aussi.
//
// D'où ce déroulement côté agentHub, et pour Codex seulement. Laisser le CLI faire quand il
// sait faire n'est pas de la paresse : une skill de Claude peut restreindre ses outils,
// s'appuyer sur des fichiers annexes, ne charger ses détails qu'au besoin. Remplacer ça par
// un copier-coller de son corps perdrait tout. On ne le fait donc que là où l'alternative
// est de ne rien avoir.

const EXPANDS_ITSELF = new Set(['claude', 'grok']);

/** Corps d'une skill, frontmatter retiré. */
function bodyOf(text) {
  const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text || '');
  return (front ? text.slice(front[0].length) : text || '').trim();
}

/**
 * Remplace un `/nom` de tête par le mode opératoire de la skill, pour un fournisseur qui ne
 * sait pas le faire. Le reste de la ligne suit : c'est l'argument, et une skill s'en sert
 * (« /create-pr en draft »).
 *
 * Sans correspondance, le texte repart inchangé : mieux vaut un agent qui répond « je ne
 * connais pas cette commande » qu'un message avalé.
 *
 * @param {string} provider
 * @param {string} text
 * @param {string} [cwd] pour trouver d'abord une skill de projet, comme les CLIs le font
 */
function expand(provider, text, cwd) {
  if (EXPANDS_ITSELF.has(provider)) return text;
  const match = /^\/([a-z0-9][a-z0-9:-]*)\s*([\s\S]*)$/i.exec(String(text || '').trim());
  if (!match) return text;

  const [, name, rest] = match;
  // Le préfixe de plugin ne correspond à aucun dossier : on cherche sous le nom court.
  const bare = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  if (!SKILL_NAME_RE.test(bare)) return text;

  // Portée projet d'abord, comme les CLIs : une skill du projet masque son homonyme global.
  const raw = readSkill(bare, 'project', cwd) || readSkill(bare, 'global', cwd);
  if (!raw) return text;

  const body = bodyOf(raw);
  if (!body) return text;

  const parts = [
    `Mode opératoire à suivre — la skill « ${bare} », déroulée par agentHub parce que ton CLI`,
    'ne sait pas le faire lui-même :',
    '',
    body,
  ];
  if (rest.trim()) parts.push('', '---', `Demande de l'utilisateur : ${rest.trim()}`);
  return parts.join('\n');
}

/** Contenu d'une skill, pour la relire ou la modifier. */
function readSkill(name, scope, cwd) {
  if (!SKILL_NAME_RE.test(name)) return null;
  const dir = dirOf(name, scope, cwd);
  if (!dir) return null;
  try {
    return fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
}

module.exports = {
  remember,
  list,
  inventory,
  move,
  create,
  remove,
  readSkill,
  expand,
  bodyOf,
  EXPANDS_ITSELF,
  forgetDescriptions,
  describeFile,
  HIDDEN,
  CATALOGUE,
  SKILL_NAME_RE,
};
