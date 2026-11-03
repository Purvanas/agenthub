'use strict';

// Portée annulable commune aux actions asynchrones. Elle évite que chaque écran réinvente
// « la réponse appartient-elle encore à ce que l'utilisateur regarde ? ».
(function actionContextModule(global) {
  let generation = 0;
  const live = new Set();

  function currentState() {
    return global.agentHub && global.agentHub.getState ? global.agentHub.getState() : null;
  }

  function capture(options = {}) {
    const controller = new AbortController();
    const born = generation;
    const conversationId = options.conversationId || null;
    const view = options.view || null;
    const key = options.key || null;
    const scope = {
      conversationId,
      view,
      key,
      signal: controller.signal,
      abort(reason) {
        if (!controller.signal.aborted) {
          controller.abort(new DOMException(reason || 'Navigation', 'AbortError'));
        }
        live.delete(scope);
      },
      release() {
        live.delete(scope);
      },
      isCurrent() {
        if (controller.signal.aborted || born !== generation) return false;
        const state = currentState();
        if (conversationId && (!state || state.currentId !== conversationId)) return false;
        if (view && global.AgentHubNavigation) {
          const route = global.AgentHubNavigation.current();
          if (route.view !== view) return false;
        }
        return true;
      },
      guard(callback) {
        if (!scope.isCurrent()) return undefined;
        return callback();
      },
      async run(task) {
        try {
          const result = await task(controller.signal, scope);
          return scope.isCurrent() ? result : undefined;
        } finally {
          scope.release();
        }
      },
    };
    live.add(scope);
    return scope;
  }

  function invalidate(reason) {
    generation += 1;
    for (const scope of [...live]) scope.abort(reason || 'navigation');
  }

  global.addEventListener('agenthub:navigation', () => invalidate('navigation'));
  global.AgentHubActionContext = {
    capture,
    invalidate,
    generation: () => generation,
  };
})(window);
