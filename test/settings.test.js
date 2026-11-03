'use strict';

// Superposition des réglages : `config/*.json` donne les défauts du dépôt, `data/settings.json`
// ce que la page de réglages a changé.
//
// Le risque n'est pas de mal afficher un champ, c'est d'écrire au mauvais endroit. Une
// surcharge qui atterrirait dans `config/` salirait la copie de travail que le déploiement
// met à jour, et `git push` refuserait sans dire pourquoi. Ces tests tiennent la frontière,
// et deux autres choses qui ne se voient pas à l'œil : un mot de passe qu'on efface en
// enregistrant sans le retaper, et une ligne qu'on n'arrive plus à supprimer.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');

/** Chaque test a son propre `data/settings.json`, dans un dossier jetable. */
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-settings-'));
  const file = path.join(dir, 'settings.json');
  process.env.AGENTHUB_SETTINGS = file;
  delete require.cache[require.resolve('../lib/settings')];
  return { settings: require('../lib/settings'), file, dir };
}

function repoDefaults(name) {
  return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, name), 'utf8'));
}

test('sans surcharge, on lit exactement le fichier du dépôt', () => {
  const { settings } = fresh();
  const repo = repoDefaults('browser.json');

  const read = settings.read('browser');
  assert.equal(read.url, repo.url);
  assert.equal(read.name, repo.name);
  // Les clés `_doc` traversent : elles portent la raison d'être des réglages, et rien ne
  // gagne à les faire disparaître des lectures.
  assert.ok(read._doc);
});

test("enregistrer n'écrit que dans data/, jamais dans config/", () => {
  const { settings, file } = fresh();
  const avant = fs.readFileSync(path.join(CONFIG_DIR, 'notify.json'), 'utf8');

  settings.save('notify', { enabled: true, topic: 'agenthub-demo' });

  // C'est tout l'objet de ce module : `config/` est suivi par git, et le déploiement refuse
  // un push si la copie de travail est sale.
  assert.equal(fs.readFileSync(path.join(CONFIG_DIR, 'notify.json'), 'utf8'), avant);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    notify: { enabled: true, topic: 'agenthub-demo' },
  });
});

test('la surcharge prime, le reste continue de venir du dépôt', () => {
  const { settings } = fresh();
  settings.save('notify', { topic: 'salon' });

  const read = settings.read('notify');
  assert.equal(read.topic, 'salon');
  assert.equal(read.url, repoDefaults('notify.json').url);
  assert.deepEqual(read.events, repoDefaults('notify.json').events);
});

test('une valeur ramenée au défaut cesse d’être une surcharge', () => {
  const { settings, file } = fresh();
  const repo = repoDefaults('browser.json');

  settings.save('browser', { url: 'http://localhost:9999/mcp' });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).browser), ['url']);

  settings.save('browser', { url: repo.url });

  // Sinon une correction arrivée par `git pull` resterait masquée par une surcharge qui ne
  // change plus rien, et personne ne comprendrait pourquoi la nouvelle valeur n'a pas pris.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
});

test('les champs inconnus sont refusés, pas écrits', () => {
  const { settings } = fresh();
  // Sans ce filtre, la page de réglages serait un moyen d'injecter n'importe quelle clé dans
  // le fichier qui pilote les requêtes sortantes.
  settings.save('notify', { topic: 'ok', method: 'DELETE', headers: { Authorization: 'x' } });

  const read = settings.read('notify');
  assert.equal(read.topic, 'ok');
  assert.equal(read.method, undefined);
  assert.deepEqual(read.headers, repoDefaults('notify.json').headers);
});

test('un mot de passe laissé vide reste celui qu’on avait', () => {
  const { settings } = fresh();
  settings.save('mail', { host: 'smtp.exemple.fr', from: 'a@b.fr', pass: 'secret' });

  // Le geste ordinaire : ouvrir la page, changer le port, enregistrer. Le champ mot de passe
  // revient vide puisqu'il ne repart jamais vers le navigateur — l'enregistrer ne doit pas
  // effacer ce qui est en place.
  settings.save('mail', { port: 465, pass: '' });

  assert.equal(settings.read('mail').pass, 'secret');
  assert.equal(settings.read('mail').port, 465);
});

test('le mot de passe ne repart jamais vers le navigateur', () => {
  const { settings } = fresh();
  settings.save('mail', { pass: 'secret' });

  const ui = settings.forUi('mail');
  assert.equal(ui.values.pass, '');
  assert.equal(ui.values.passSet, true); // de quoi afficher « inchangé » sans le montrer
  assert.ok(!JSON.stringify(ui).includes('secret'));
});

test('une liste se remplace, elle ne fusionne pas', () => {
  const { settings } = fresh();
  settings.save('groups', { exclude: ['node_modules', '.bak'] });
  settings.save('groups', { exclude: ['node_modules'] });

  // Une fusion de tableaux rendrait toute suppression impossible, et ce genre de bug se
  // cherche longtemps : la ligne retirée réapparaît sans qu'on comprenne d'où.
  assert.deepEqual(settings.read('groups').exclude, ['node_modules']);
});

test('les lignes vides d’un textarea ne deviennent pas des entrées', () => {
  const { settings } = fresh();
  settings.save('groups', { exclude: '  node_modules \n\n  \n^snap$\n' });
  assert.deepEqual(settings.read('groups').exclude, ['node_modules', '^snap$']);
});

test('un groupe sans nom ou sans motif est jeté', () => {
  const { settings } = fresh();
  settings.save('groups', {
    groups: [
      { label: 'Pro', patterns: ['/home/a/*'] },
      { label: '', patterns: ['/x'] },
      { label: 'Vide', patterns: [] },
    ],
  });
  // Le garder ferait une ligne vide dans le sélecteur de dossier, sans qu'on sache d'où elle
  // sort.
  assert.deepEqual(settings.read('groups').groups, [{ label: 'Pro', patterns: ['/home/a/*'] }]);
});

test('un port hors bornes est refusé au lieu d’être arrondi', () => {
  const { settings } = fresh();
  assert.throws(() => settings.save('mail', { port: 0 }), /port invalide/);
  assert.throws(() => settings.save('mail', { port: 99999 }), /port invalide/);
  assert.throws(() => settings.save('mail', { port: 'smtp' }), /port invalide/);
});

test('un format de notification inconnu est refusé', () => {
  const { settings } = fresh();
  assert.throws(() => settings.save('notify', { format: 'telegram' }), /ntfy ou json/);
});

test('les issues notifiées gardent leur ordre, quoi qu’envoie le formulaire', () => {
  const { settings } = fresh();
  settings.save('notify', { events: ['stopped', 'inconnu', 'done'] });
  assert.deepEqual(settings.read('notify').events, ['done', 'stopped']);
});

test('une section inconnue est refusée', () => {
  const { settings } = fresh();
  assert.throws(() => settings.read('pricing'), /inconnue/);
  assert.throws(() => settings.save('pricing', { claude: {} }), /inconnue/);
});

test('remettre à zéro rend les valeurs du dépôt', () => {
  const { settings, file } = fresh();
  settings.save('browser', { enabled: false, url: 'http://ailleurs/mcp' });

  const back = settings.reset('browser');
  assert.equal(back.url, repoDefaults('browser.json').url);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
});

test('un fichier de surcharges illisible ne fait pas tomber la lecture', () => {
  const { settings, file } = fresh();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ ceci n’est pas du json');

  // Un fichier corrompu par un crash ne doit pas éteindre l'application : on retombe sur le
  // dépôt, qui est toujours lisible.
  assert.equal(settings.read('browser').url, repoDefaults('browser.json').url);
});
