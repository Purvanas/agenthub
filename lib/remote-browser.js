'use strict';

// Navigateur d'intervention humaine.
//
// Playwright MCP donne deja Chromium aux agents, mais en headless : quand Google, Vercel ou
// un autre service reclame une connexion, l'utilisateur ne peut ni voir la page ni saisir son
// mot de passe. Ce module ouvre ponctuellement le MEME profil persistant et expose seulement
// une image et des gestes (clic, frappe, defilement) a l'interface agentHub.
//
// Le mot de passe n'est jamais journalise : le navigateur recoit directement le texte. Une
// fois la fenetre fermee, le prochain Chromium ouvert par Playwright MCP retrouve les cookies.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'connections.json');

let context = null;
let page = null;
let startedAt = null;
let lastError = null;
let displayProcess = null;

function stopVirtualDisplay() {
  const child = displayProcess;
  displayProcess = null;
  if (child && child.exitCode === null) child.kill('SIGTERM');
}

async function startVirtualDisplay(width, height) {
  // Google refuse les navigateurs headless pour la connexion. Xvfb donne a Chromium un
  // vrai ecran Linux tout en continuant a transmettre l'image dans la modale agentHub.
  let number = null;
  for (let candidate = 90; candidate < 120; candidate += 1) {
    if (
      !fs.existsSync(`/tmp/.X11-unix/X${candidate}`) &&
      !fs.existsSync(`/tmp/.X${candidate}-lock`)
    ) {
      number = candidate;
      break;
    }
  }
  if (number === null) throw new Error('Aucun ecran virtuel X11 disponible');

  const display = `:${number}`;
  const child = spawn('/usr/bin/Xvfb', [
    display,
    '-screen',
    '0',
    `${width}x${height}x24`,
    '-nolisten',
    'tcp',
    '-ac',
  ], { stdio: 'ignore' });
  displayProcess = child;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (fs.existsSync(`/tmp/.X11-unix/X${number}`)) return display;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  stopVirtualDisplay();
  throw new Error("L'ecran virtuel du navigateur n'a pas demarre");
}

function config() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    /* configuration absente : les valeurs du serveur courant restent utilisables */
  }
  return {
    playwright: String(raw.playwright || './playwright-mcp/node_modules/playwright'),
    profile: String(raw.profile || './playwright-mcp/profile'),
    width: Math.max(800, Math.min(1920, Number(raw.width) || 1280)),
    height: Math.max(600, Math.min(1200, Number(raw.height) || 800)),
  };
}

function safeUrl(value) {
  const raw = String(value || '').trim() || 'https://www.google.com';
  // Une chaine qui annonce deja un protocole ne doit jamais etre « reparee » en lui
  // prefixant https : `javascript:...` deviendrait seulement une URL confuse a refuser.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) {
    throw new Error('Seules les adresses http et https sont acceptees');
  }
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error('Adresse web invalide');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Seules les adresses http et https sont acceptees');
  }
  return url.href;
}

function view() {
  return {
    running: Boolean(context && page),
    url: page ? page.url() : null,
    title: null,
    startedAt,
    error: lastError,
    viewport: { width: config().width, height: config().height },
  };
}

async function start(url) {
  const target = safeUrl(url);
  if (!context) {
    const conf = config();
    let chromium;
    try {
      ({ chromium } = require(conf.playwright));
    } catch (err) {
      throw new Error(`Playwright indisponible : ${err.message}`);
    }
    fs.mkdirSync(conf.profile, { recursive: true });
    let display;
    try {
      display = await startVirtualDisplay(conf.width, conf.height);
      context = await chromium.launchPersistentContext(conf.profile, {
        headless: false,
        viewport: { width: conf.width, height: conf.height },
        env: { ...process.env, DISPLAY: display },
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
      });
    } catch (err) {
      context = null;
      stopVirtualDisplay();
      throw new Error(
        `Le profil du navigateur est deja utilise par un agent. Attends la fin de son tour puis reessaie. (${err.message})`
      );
    }
    page = context.pages()[0] || (await context.newPage());
    await page.addInitScript(
      "Object.defineProperty(navigator, 'webdriver', { get: () => undefined })"
    );
    startedAt = new Date().toISOString();
    lastError = null;
    context.on('close', () => {
      context = null;
      page = null;
      startedAt = null;
      stopVirtualDisplay();
    });
    // OAuth ouvre souvent une nouvelle page. Ecouter le contexte couvre aussi les pop-ups
    // ouverts depuis un pop-up, contrairement a un gestionnaire pose seulement sur la page
    // initiale.
    context.on('page', async (opened) => {
      page = opened;
      await page.bringToFront().catch(() => {});
    });
  }
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  return state();
}

async function state() {
  const out = view();
  if (page) out.title = await page.title().catch(() => '');
  return out;
}

function active() {
  if (!page || !context) throw new Error('Le navigateur serveur n’est pas ouvert');
  return page;
}

async function screenshot() {
  return active().screenshot({ type: 'jpeg', quality: 72, animations: 'disabled' });
}

async function navigate(url) {
  await active().goto(safeUrl(url), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  return state();
}

async function click(x, y) {
  await active().mouse.click(Number(x), Number(y));
  return state();
}

async function type(text) {
  // insertText ne simule pas des raccourcis et ne copie rien dans le presse-papiers du
  // serveur. C'est exactement ce qu'il faut pour identifiants et mots de passe.
  await active().keyboard.insertText(String(text || ''));
  return state();
}

const KEYS = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Alt+ArrowLeft',
]);

async function key(name) {
  if (!KEYS.has(name)) throw new Error('Touche non autorisee');
  await active().keyboard.press(name);
  return state();
}

async function scroll(deltaY) {
  await active().mouse.wheel(0, Math.max(-3000, Math.min(3000, Number(deltaY) || 0)));
  return state();
}

async function close() {
  const current = context;
  context = null;
  page = null;
  startedAt = null;
  if (current) await current.close().catch(() => {});
  stopVirtualDisplay();
  return state();
}

module.exports = {
  CONFIG_FILE,
  config,
  safeUrl,
  view,
  state,
  start,
  screenshot,
  navigate,
  click,
  type,
  key,
  scroll,
  close,
};
