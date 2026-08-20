    /* ---- Authoring chrome: floating toolbar (undo/redo/publish/reset). A convenience
       over the $edit magic — built on first use and shown only where there is
       something to edit, so it never sits on a route with no editable area. ---- */
    let bar;
    function buildUI() {
        if (bar) return bar;
        bar = document.createElement('div'); bar.setAttribute('data-edit-toolbar', '');
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
        return bar;
    }
    // An area hidden by the router is still in the DOM, so ask the layout, not the tree.
    const onScreen = (el) => el.checkVisibility ? el.checkVisibility() : !!el.offsetParent;
    function refresh() {
        if (estore) { estore.canUndo = cursor > 0; estore.canRedo = cursor < log.length; }
        if (!areas().some(a => isActive(a) && onScreen(a) && !a._edit.quiet)) { if (bar) bar.hidden = true; return; }
        buildUI().hidden = false;
        bar.querySelector('[data-a="undo"]').disabled = cursor === 0;
        bar.querySelector('[data-a="redo"]').disabled = cursor >= log.length;
    }
