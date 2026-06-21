    /* ---- Dev chrome: floating toolbar (undo/redo/publish/reset). Spike-only — the
       author drives activation via the $edit magic; this is just a convenience. ---- */
    let bar;
    function buildUI() {
        bar = document.createElement('div'); bar.className = 'edit-toolbar';
        bar.innerHTML = '<button class="ghost" data-a="undo">↶ Undo</button><button class="ghost" data-a="redo">↷ Redo</button><button class="brand" data-a="publish">Publish</button><button class="ghost" data-a="reset">Reset</button>';
        bar.addEventListener('click', e => {
            const btn = e.target.closest('button'); if (!btn) return; const a = btn.getAttribute('data-a');
            if (a === 'undo') undo(); if (a === 'redo') redo(); if (a === 'reset') { localStorage.removeItem(LS_KEY); location.reload(); }
            if (a === 'publish') {
                const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Publishing…';
                publish().then(r => { const rs = r.results || []; const w = rs.filter(x => x.status === 'written').length, sk = rs.filter(x => x.status === 'skipped').length; btn.textContent = `Wrote ${w}${sk ? ` · ${sk} skipped` : ''}`; })
                    .catch(() => btn.textContent = 'Failed').finally(() => { btn.disabled = false; setTimeout(() => btn.textContent = orig, 2800); });
            }
        });
        document.body.appendChild(bar);
    }
    function refresh() {
        if (estore) { estore.canUndo = cursor > 0; estore.canRedo = cursor < log.length; }
        if (bar) { bar.querySelector('[data-a="undo"]').disabled = cursor === 0; bar.querySelector('[data-a="redo"]').disabled = cursor >= log.length; }
    }
