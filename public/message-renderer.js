'use strict';

// Rendu pur des contenus de conversation. L'identifiant de conversation est fourni à chaque
// appel : une réponse ou une navigation tardive ne peut donc pas rattacher une image Markdown
// au fil devenu courant entre-temps.
(function expose(root) {
  function create(options = {}) {
    const ideas = options.ideas;
    const numberFormat = new Intl.NumberFormat(options.locale || 'fr-FR');
    const textExtensions = new Set(['md', 'markdown', 'json']);

    function esc(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function escAttr(value) {
      return esc(value).replace(/"/g, '&quot;');
    }

    // Reçoit toujours du texte déjà échappé.
    function inline(escaped) {
      return escaped
        .replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`)
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    }

    function md(text, context = {}) {
      const blocks = [];
      let source = String(text || '').replace(/```(\w*)\n?([\s\S]*?)```/g, (_, language, code) => {
        blocks.push(`<pre><code data-lang="${escAttr(language)}">${esc(code.replace(/\n$/, ''))}</code></pre>`);
        return `\u0000${blocks.length - 1}\u0000`;
      });

      source = source.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, target) => {
        const url = /^https?:\/\//i.test(target)
          ? target
          : `/api/conversations/${encodeURIComponent(context.conversationId || '')}/image?path=${encodeURIComponent(target)}`;
        blocks.push(
          `<img class="msg-img" src="${escAttr(url)}" alt="${escAttr(alt)}" title="${escAttr(target)}" ` +
            `data-image="${escAttr(url)}" data-name="${escAttr(alt || target)}" data-path="${escAttr(target)}" loading="lazy">`
        );
        return `\u0000${blocks.length - 1}\u0000`;
      });

      if (ideas && ideas.IDEA_LINE && typeof ideas.match === 'function') {
        source = source.replace(new RegExp(ideas.IDEA_LINE.source, 'gim'), (line) => {
          const idea = ideas.match(line);
          if (!idea) return line;
          blocks.push(
            `<div class="idea">` +
              `<svg class="icon"><use href="#i-note"/></svg>` +
              `<div class="idea-text"><strong>${inline(esc(idea.title))}</strong>` +
              (idea.body ? `<span>${inline(esc(idea.body))}</span>` : '') +
              `</div>` +
              `<button class="idea-do" data-idea-title="${escAttr(idea.title)}" ` +
              `data-idea-body="${escAttr(idea.body)}">Faire</button>` +
              `<button class="idea-add" data-idea-title="${escAttr(idea.title)}" ` +
              `data-idea-body="${escAttr(idea.body)}">Ajouter à la todo</button>` +
              `</div>`
          );
          return `\n\n\u0000${blocks.length - 1}\u0000\n\n`;
        });
      }

      source = inline(esc(source));

      const renderBlock = (paragraph) => {
        const lines = paragraph.split('\n');
        const heading = lines.findIndex((line) => /^#{1,4}\s+\S/.test(line));
        if (heading !== -1) {
          const [, hashes, title] = lines[heading].match(/^(#{1,4})\s+(.+)$/);
          const level = hashes.length + 1;
          return (
            renderBlock(lines.slice(0, heading).join('\n')) +
            `<h${level} class="md-h">${title}</h${level}>` +
            renderBlock(lines.slice(heading + 1).join('\n'))
          );
        }
        if (!paragraph.trim()) return '';
        if (lines.every((line) => !line.trim() || /^\u0000\d+\u0000$/.test(line.trim()))) {
          return lines.map((line) => line.trim()).join('');
        }
        if (lines.every((line) => /^\s*[-*+]\s+/.test(line))) {
          return `<ul class="ul">${lines.map((line) => `<li>${line.replace(/^\s*[-*+]\s+/, '')}</li>`).join('')}</ul>`;
        }
        if (lines.every((line) => /^\s*\d{1,3}[.)]\s+/.test(line))) {
          return `<ol class="ul">${lines.map((line) => `<li>${line.replace(/^\s*\d{1,3}[.)]\s+/, '')}</li>`).join('')}</ol>`;
        }
        return `<p>${lines.join('<br>')}</p>`;
      };

      const html = source.split(/\n{2,}/).map(renderBlock).join('');
      return html.replace(/\u0000(\d+)\u0000/g, (_, index) => blocks[Number(index)]);
    }

    function fileExtOf(name) {
      const match = /\.([a-z0-9]+)$/i.exec(name || '');
      return match ? match[1].toLowerCase() : '';
    }

    function isTextName(name) {
      return textExtensions.has(fileExtOf(name));
    }

    function attachmentIsText(attachment) {
      if (!attachment) return false;
      if (attachment.kind === 'text') return true;
      if (attachment.kind === 'image') return false;
      return isTextName(attachment.name) || isTextName(attachment.url);
    }

    function textBadge(name) {
      const extension = fileExtOf(name);
      if (extension === 'md' || extension === 'markdown') return 'MD';
      if (extension === 'json') return 'JSON';
      return (extension || 'FILE').toUpperCase().slice(0, 4);
    }

    function renderStoredAttachment(attachment) {
      if (attachmentIsText(attachment)) {
        const badge = textBadge(attachment.name || attachment.url);
        return `<a class="msg-file" href="${escAttr(attachment.url)}" target="_blank" rel="noopener" title="${escAttr(attachment.name)}"><span class="msg-file-ext">${esc(badge)}</span><span class="msg-file-name">${esc(attachment.name)}</span></a>`;
      }
      return `<button data-image="${escAttr(attachment.url)}" data-name="${escAttr(attachment.name)}" title="${escAttr(attachment.name)}"><img src="${escAttr(attachment.url)}" alt="${escAttr(attachment.name)}" loading="lazy"></button>`;
    }

    function summarizeInput(item) {
      const input = item.input || {};
      if (typeof input === 'string') return input;
      const first = input.command || input.file_path || input.path || input.pattern || input.query ||
        input.prompt || input.files || input.url || input.description;
      return first ? String(first) : Object.keys(input).length ? JSON.stringify(input) : '';
    }

    function skillCall(text) {
      return esc(text).replace(/^\/([a-z0-9][a-z0-9:-]*)/i, '<span class="skill-call">/$1</span>');
    }

    const nestedClass = (item) => (item.nested ? ' nested' : '');
    const nestedTitle = (item) => (item.nested ? ' title="Produit par un sous-agent"' : '');

    function renderItem(item, context = {}) {
      switch (item.kind) {
        case 'user': {
          const images = (item.images || []).map(renderStoredAttachment).join('');
          const checkpoint = item.checkpoint;
          const rewind = checkpoint && checkpoint.sha
            ? `<button class="msg-rewind" data-rewind="${esc(checkpoint.sha)}" title="Restaurer les fichiers à leur état d'avant ce message"><svg class="icon"><use href="#i-rewind"/></svg>Fichiers</button>`
            : '';
          if (item.handoff === 'request') {
            return `<details class="msg msg-user msg-handoff" data-item="${item.id}"><summary><svg class="icon"><use href="#i-relay"/></svg>Note de passation demandée pour un relais</summary><div class="handoff-body">${esc(item.text)}</div></details>`;
          }
          if (item.goal) {
            const heading = {
              start: `Objectif ouvert${item.goalText ? ` — ${esc(item.goalText)}` : ''}`,
              check: 'Point sur l’objectif demandé',
              continue: 'Relance : ce qui reste à faire',
            }[item.goal];
            return `<details class="msg msg-user msg-handoff msg-goal" data-item="${item.id}"><summary><svg class="icon"><use href="#i-target"/></svg>${heading || 'Mode objectif'}</summary><div class="handoff-body">${esc(item.text)}</div></details>`;
          }
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
              }</div>${md(item.text, context)}</div>`;
          }
          return `<div class="msg msg-text${nestedClass(item)}" data-item="${item.id}"${nestedTitle(item)}>${md(item.text, context)}</div>`;

        case 'thinking':
          return `<details class="think${nestedClass(item)}" data-item="${item.id}"${nestedTitle(item)}><summary>Réflexion</summary><div class="tool-body">${esc(item.text)}</div></details>`;

        case 'tool': {
          const body = [];
          if (item.input && Object.keys(item.input).length) {
            body.push(`<pre>${esc(typeof item.input === 'string' ? item.input : JSON.stringify(item.input, null, 2))}</pre>`);
          }
          if (item.result != null && item.result !== '') {
            const text = String(item.result);
            const total = Number(item.resultLength) || text.length;
            const truncated = !item._resultExpanded && (item.resultTruncated || total > text.length);
            const suffix = truncated ? `\n… (${numberFormat.format(total)} caractères au total)` : '';
            body.push(`<pre>${esc(text + suffix)}</pre>`);
            if (truncated) {
              body.push(`<button class="tool-result-more" data-tool-result="${escAttr(item.id)}">Afficher le résultat complet</button>`);
            }
          }
          const shots = (item.images || []).length
            ? `<div class="tool-shots">${item.images.map((image) =>
                `<button data-image="${escAttr(image.url)}" data-name="${escAttr(image.name || 'capture')}" title="Agrandir">
                  <img src="${escAttr(image.url)}" alt="${escAttr(image.name || 'capture')}" loading="lazy" decoding="async">
                </button>`
              ).join('')}</div>`
            : '';
          if (shots) body.push(shots);
          return `<details class="tool${item.isError ? ' err' : ''}${nestedClass(item)}${shots ? ' has-shots' : ''}" data-item="${item.id}"${nestedTitle(item)}${shots ? ' open' : ''}>
            <summary><span class="tool-name">${esc(item.tool)}</span><span class="tool-arg">${esc(summarizeInput(item))}</span></summary>
            <div class="tool-body">${body.join('')}</div>
          </details>`;
        }

        case 'result':
          return item.isError
            ? `<div class="msg-err" data-item="${item.id}">${esc(item.text || 'Erreur')}</div>`
            : '';

        case 'notice': {
          const undo = item.checkpoint && item.checkpoint.sha
            ? ` <button class="msg-undo" data-rewind="${esc(item.checkpoint.sha)}"><svg class="icon"><use href="#i-rewind"/></svg>${esc(item.checkpointLabel || 'Revenir')}</button>`
            : '';
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

    return Object.freeze({
      esc,
      escAttr,
      inline,
      md,
      renderItem,
      attachments: Object.freeze({ fileExtOf, isTextName, attachmentIsText, textBadge }),
    });
  }

  root.AgentHubMessageRenderer = Object.freeze({ create });
})(window);
