'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');

function renderer() {
  const context = vm.createContext({ window: {}, console });
  for (const file of ['ideas.js', 'message-renderer.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), context, { filename: file });
  }
  return vm.runInContext("window.AgentHubMessageRenderer.create({ ideas, locale: 'fr-FR' })", context);
}

test('le Markdown échappe le HTML et les valeurs placées dans des attributs', () => {
  const html = renderer().md(
    '**sûr** <script>alert("x")</script>\n\n![photo "large](capture.png)',
    { conversationId: 'conversation-a' }
  );
  assert.match(html, /<strong>sûr<\/strong>/);
  assert.match(html, /&lt;script&gt;alert\("x"\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /alt="photo &quot;large"/);
});

test('une image Markdown reste rattachée au contexte de conversation fourni', () => {
  const view = renderer();
  const first = view.md('![capture](artifacts/vue-mobile.png)', { conversationId: 'conversation-a' });
  const second = view.renderItem(
    { kind: 'text', id: 'm2', text: '![capture](artifacts/vue.png)' },
    { conversationId: 'conversation-b' }
  );
  assert.match(first, /\/api\/conversations\/conversation-a\/image\?path=artifacts%2Fvue-mobile\.png/);
  assert.doesNotMatch(first, /conversation-b/);
  assert.match(second, /\/api\/conversations\/conversation-b\/image\?path=artifacts%2Fvue\.png/);
  assert.doesNotMatch(second, /conversation-a/);
});

test('un résultat d’outil tronqué annonce sa taille et propose son chargement complet', () => {
  const html = renderer().renderItem({
    kind: 'tool',
    id: 'outil-1',
    tool: 'exec',
    input: { command: 'echo <secret>' },
    result: 'début',
    resultLength: 12000,
    resultTruncated: true,
  });
  assert.match(html, /echo &lt;secret&gt;/);
  assert.match(html, /12[^0-9]?000 caractères au total/);
  assert.match(html, /class="tool-result-more" data-tool-result="outil-1"/);
  assert.match(html, /Afficher le résultat complet/);
});

test('les pièces jointes utilisateur gardent leur type et échappent leurs attributs', () => {
  const html = renderer().renderItem({
    kind: 'user',
    id: 'message-1',
    text: 'Regarde',
    images: [
      { name: 'capture "mobile".png', url: '/images/capture.png?x=1&mode="large"' },
      { name: 'notes.md', url: '/files/notes.md' },
    ],
  });
  assert.match(html, /class="msg-images"/);
  assert.match(html, /data-name="capture &quot;mobile&quot;\.png"/);
  assert.match(html, /mode=&quot;large&quot;/);
  assert.match(html, /class="msg-file"/);
  assert.match(html, /<span class="msg-file-ext">MD<\/span>/);
});

test('le renderer est chargé après les idées et avant app.js', () => {
  const view = renderer();
  assert.deepEqual(Object.keys(view).sort(), ['attachments', 'esc', 'escAttr', 'inline', 'md', 'renderItem']);
  assert.deepEqual(Object.keys(view.attachments).sort(), ['attachmentIsText', 'fileExtOf', 'isTextName', 'textBadge']);
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const ideas = html.indexOf('<script src="/ideas.js"></script>');
  const messages = html.indexOf('<script src="/message-renderer.js"></script>');
  const app = html.indexOf('<script src="/app.js"></script>');
  assert.ok(ideas >= 0 && messages > ideas && app > messages);
});
