'use strict';

// Navigateur donné à une conversation, pour que l'agent puisse regarder ce qu'il produit.
//
// Le navigateur lui-même n'est pas ici : c'est un serveur MCP Playwright qui tourne à
// côté, avec son propre Chromium. agentHub ne fait que dire à un CLI comment le joindre.
// Ce découpage est délibéré — un dépôt cloné sans le service reste utilisable, et un
// Chromium de 115 Mo n'est pas une dépendance d'une interface web.
//
// Il n'y a pas de session par conversation : le serveur tourne en contexte partagé, donc
// tous les agents qui s'y connectent voient la même page. C'est ce qui permettra de
// regarder ce que l'agent fait, mais ça veut aussi dire que deux conversations qui
// naviguent en même temps se marchent dessus.

const path = require('path');
const settings = require('./settings');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'browser.json');

/**
 * Relu à chaque appel : activer le navigateur depuis la page Paramètres ne demande pas de
 * redémarrage. Défauts dans `config/browser.json`, modifications dans `data/settings.json`.
 */
function config() {
  const raw = settings.read('browser');
  const url = String(raw.url || '').trim();
  return {
    enabled: Boolean(raw.enabled) && Boolean(url),
    url,
    name: String(raw.name || 'playwright').trim() || 'playwright',
    grokGlobal: Boolean(raw.grokGlobal),
  };
}

/**
 * Fournisseurs capables de recevoir une configuration MCP au moment de l'appel.
 *
 * Grok en est incapable : ni `--mcp-config`, ni surcharge de config en ligne de commande.
 * La seule voie est `grok mcp add`, qui écrit dans `~/.grok/config.toml` et vaut donc pour
 * toutes ses sessions. Un navigateur *par conversation* lui est hors de portée.
 */
const CAPABLE = new Set(['claude', 'codex']);

/** Fournisseurs dont le navigateur ne peut être qu'inscrit globalement, hors de l'app. */
const GLOBAL_ONLY = new Set(['grok']);

/** Ce fournisseur peut-il recevoir un navigateur pour une conversation donnée ? */
function supports(provider) {
  return CAPABLE.has(provider) && config().enabled;
}

/**
 * Ce fournisseur a-t-il le navigateur en permanence, par une inscription faite hors de
 * l'app ? Déclaré dans la configuration et non détecté : lancer `grok mcp list` à chaque
 * affichage pour un simple libellé ne vaut pas son coût, et deviner serait pire que dire.
 *
 * La distinction compte pour l'UI : une case à cocher qui ne peut rien décocher est un
 * mensonge, un indicateur qui dit « toujours actif » est une information.
 */
function alwaysOn(provider) {
  const conf = config();
  return GLOBAL_ONLY.has(provider) && conf.enabled && conf.grokGlobal;
}

/** Configuration MCP au format attendu par les fichiers de config des CLIs. */
function mcpServers() {
  const { name, url } = config();
  // `type: 'http'` n'est pas décoratif : sans lui, Claude Code ignore l'entrée en
  // silence — `mcp_servers` reste vide dans son événement `init`. Mesuré le 01/08/2026.
  return { mcpServers: { [name]: { type: 'http', url } } };
}

module.exports = { config, supports, alwaysOn, mcpServers, CONFIG_FILE };
