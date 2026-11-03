'use strict';

// La galerie garde ici son état et ses événements. app.js lui injecte les primitives
// partagées : aucun détail de conversation ne devient une dépendance implicite.
(function expose(root) {
  function create(d) {
    const key = { project: 'galleryProject', agents: 'galleryAgents' };
    let projects = [];
    let projectRequest = 0;
    let imageRequest = 0;
    let mounted = false;
    const visible = () => !d.$('#gallery-view').classList.contains('hidden');
    const selectedAgents = () =>
      [...document.querySelectorAll('#gal-agents .gal-agent.on')].map((b) => b.dataset.agent);

    function renderAgents() {
      const chosen = new Set(d.prefs.read(key.agents, d.usableProviders()));
      d.$('#gal-agents').innerHTML = d.usableProviders().map((provider) => {
        const label = d.providerLabels[provider] || provider;
        return `<button class="gal-agent${chosen.has(provider) ? ' on' : ''}" data-agent="${provider}" ` +
          `title="${d.escAttr(label)}">${d.providerIcon(provider)}<span>${d.esc(label)}</span></button>`;
      }).join('');
    }

    function imageCard(image) {
      const name = d.providerLabels[image.provider] || image.provider;
      const cost = image.costUsd ? `<span class="gal-cost">${d.money(image.costUsd)}</span>` : '';
      let body = '<div class="gal-pending">génération…</div>';
      if (image.state === 'done' && image.file) {
        const url = `/api/gallery/images/${image.id}/file`;
        body = `<img class="gal-img" src="${d.escAttr(url)}" alt="${d.escAttr(image.prompt)}" ` +
          `data-zoom="${d.escAttr(url)}" data-name="${d.escAttr(name)}" decoding="async">`;
      } else if (image.state !== 'working') {
        body = `<div class="gal-failed" title="${d.escAttr(image.error || '')}">${d.esc(
          (image.error || 'Aucune image produite').slice(0, 90)
        )}</div>`;
      }
      return `<figure class="gal-card${image.state === 'failed' ? ' failed' : ''}" data-image="${image.id}">
        ${body}<figcaption>${d.providerIcon(image.provider)}<span class="gal-who">${d.esc(name)}</span>${cost}
        <button class="gal-del" data-del="${image.id}" title="Supprimer"><svg class="icon"><use href="#i-trash"/></svg></button>
        </figcaption></figure>`;
    }

    function renderBatches(images) {
      if (!images.length) {
        d.$('#gal-batches').innerHTML = '<div class="empty">Aucune image dans ce projet. Décris ce que tu veux, choisis les agents, et lance.</div>';
        return;
      }
      const order = [];
      const batches = new Map();
      for (const image of images) {
        const id = image.batchId || image.id;
        if (!batches.has(id)) { batches.set(id, []); order.push(id); }
        batches.get(id).push(image);
      }
      d.$('#gal-batches').innerHTML = order.map((id) => {
        const batch = batches.get(id);
        return `<section class="gal-batch"><p class="gal-prompt">${d.esc(batch[0].prompt)}</p>` +
          `<div class="gal-row">${batch.map(imageCard).join('')}</div></section>`;
      }).join('');
    }

    async function loadImages() {
      const id = d.$('#gal-project').value;
      const seq = ++imageRequest;
      if (!id) {
        d.$('#gal-batches').innerHTML = '<div class="empty">Crée un projet pour commencer.</div>';
        d.$('#gallery-sub').textContent = 'Aucun projet';
        return false;
      }
      try {
        const { images } = await d.api('GET', `/api/gallery/projects/${id}/images`);
        // L'id ne suffit pas : deux rafraîchissements du même projet peuvent se répondre
        // dans le désordre. Seule la dernière requête encore visible peut repeindre la vue.
        if (seq !== imageRequest || d.$('#gal-project').value !== id || !visible()) return false;
        renderBatches(images);
        const done = images.filter((image) => image.state === 'done').length;
        const spent = images.reduce((sum, image) => sum + (image.costUsd || 0), 0);
        d.$('#gallery-sub').textContent = `${done} image${done > 1 ? 's' : ''}${spent ? ` · ${d.money(spent)}` : ''}`;
        return true;
      } catch (error) {
        if (seq === imageRequest && d.$('#gal-project').value === id && visible()) {
          d.$('#gal-batches').innerHTML = `<div class="empty">${d.esc(error.message)}</div>`;
        }
        return false;
      }
    }

    async function show() {
      d.showView('#gallery-view');
      d.renderConversationList();
      const seq = ++projectRequest;
      imageRequest += 1;
      try {
        const data = await d.api('GET', '/api/gallery');
        if (seq !== projectRequest || !visible()) return false;
        projects = data.projects;
        const wanted = d.prefs.read(key.project, null);
        const pick = projects.some((p) => p.id === wanted) ? wanted : (projects[0] || {}).id || '';
        d.$('#gal-project').innerHTML = projects.length ? projects.map((p) =>
          `<option value="${d.escAttr(p.id)}"${p.id === pick ? ' selected' : ''}>${d.esc(p.name)} (${p.count})</option>`
        ).join('') : '<option value="">Aucun projet</option>';
        d.$('#gal-project').value = pick;
        renderAgents();
        return loadImages();
      } catch (error) {
        if (seq === projectRequest && visible()) d.$('#gal-batches').innerHTML = `<div class="empty">${d.esc(error.message)}</div>`;
        return false;
      }
    }

    function mount() {
      if (mounted) return;
      mounted = true;
      d.$('#btn-gallery').addEventListener('click', () => { show(); d.closeNav(); });
      d.$('#btn-gallery-back').addEventListener('click', () => document.body.classList.add('nav-open'));
      d.$('#gal-project').addEventListener('change', () => {
        d.prefs.write(key.project, d.$('#gal-project').value); loadImages();
      });
      d.$('#gal-agents').addEventListener('click', (event) => {
        const button = event.target.closest('.gal-agent');
        if (!button) return;
        button.classList.toggle('on');
        d.prefs.write(key.agents, selectedAgents());
      });
      mountActions();
    }

    function mountActions() {
      d.$('#btn-gal-new').addEventListener('click', async () => {
        const name = await d.askInput({ title: 'Nouveau projet', label: 'Nom', ok: 'Créer' });
        if (!name || !name.trim()) return;
        try {
          const { project } = await d.api('POST', '/api/gallery/projects', { name: name.trim() });
          d.prefs.write(key.project, project.id);
          if (visible()) await show();
        } catch (error) { d.$('#gal-error').textContent = error.message; }
      });
      d.$('#btn-gal-menu').addEventListener('click', async () => {
        const id = d.$('#gal-project').value;
        const project = projects.find((p) => p.id === id);
        if (!project) return;
        const action = await d.askChoice({ title: `« ${project.name} »`, options: [
          { value: 'rename', label: 'Renommer le projet' },
          { value: 'delete', label: 'Supprimer le projet et toutes ses images', danger: true },
        ] });
        if (!action) return;
        if (action === 'delete') {
          d.undoToast({ message: `« ${project.name} » et ses images supprimés`, run: async () => {
            try {
              await d.api('DELETE', `/api/gallery/projects/${id}`);
              if (d.prefs.read(key.project, null) === id) d.prefs.write(key.project, null);
              if (visible()) await show();
            } catch (error) {
              d.$('#gal-error').textContent = error.message;
              throw error;
            }
          }});
          return;
        }
        const name = await d.askInput({ title: 'Renommer le projet', label: 'Nom', value: project.name });
        if (!name || !name.trim()) return;
        try { await d.api('PATCH', `/api/gallery/projects/${id}`, { name: name.trim() }); if (visible()) await show(); }
        catch (error) { d.$('#gal-error').textContent = error.message; }
      });
      d.$('#btn-gal-run').addEventListener('click', async () => {
        const id = d.$('#gal-project').value;
        const prompt = d.$('#gal-prompt').value.trim();
        const providers = selectedAgents();
        const error = d.$('#gal-error');
        error.textContent = '';
        if (!id) return void (error.textContent = 'Crée un projet d\'abord.');
        if (!prompt) return void (error.textContent = 'Décris ce que tu veux.');
        if (!providers.length) return void (error.textContent = 'Choisis au moins un agent.');
        d.$('#btn-gal-run').disabled = true;
        try {
          await d.api('POST', `/api/gallery/projects/${id}/generate`, { prompt, providers });
          d.$('#gal-prompt').value = ''; await loadImages();
        } catch (cause) { error.textContent = cause.message; }
        finally { d.$('#btn-gal-run').disabled = false; }
      });
      d.$('#gal-batches').addEventListener('click', (event) => {
        const zoom = event.target.closest('[data-zoom]');
        if (zoom) return d.openLightbox(zoom.dataset.zoom, zoom.dataset.name);
        const remove = event.target.closest('[data-del]');
        if (!remove) return;
        d.undoToast({ message: 'Image supprimée', hide: remove.closest('.gal-card'), run: async () => {
          try {
            await d.api('DELETE', `/api/gallery/images/${remove.dataset.del}`);
            await loadImages();
          } catch (error) {
            d.$('#gal-error').textContent = error.message;
            throw error;
          }
        }});
      });
    }

    return Object.freeze({ mount, show, loadImages });
  }
  root.AgentHubGalleryView = Object.freeze({ create });
})(window);
