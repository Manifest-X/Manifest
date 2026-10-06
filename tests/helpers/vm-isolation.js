// Records the window listeners and timers a vm-loaded plugin registers so a
// test can release them; otherwise armed retries/pollers answer later tests.
export function isolateVm(win = window) {
    const listeners = []
    const intervals = []
    const timeouts = []
    const add = win.addEventListener
    win.addEventListener = function (type, fn, opts) {
        listeners.push([type, fn, opts])
        return add.call(this, type, fn, opts)
    }
    const timers = {
        setInterval: (fn, ms, ...args) => { const id = setInterval(fn, ms, ...args); intervals.push(id); return id },
        setTimeout: (fn, ms, ...args) => { const id = setTimeout(fn, ms, ...args); timeouts.push(id); return id },
    }
    return {
        timers,
        release() {
            win.addEventListener = add
            listeners.splice(0).forEach(([type, fn, opts]) => win.removeEventListener(type, fn, opts))
            intervals.splice(0).forEach(clearInterval)
            timeouts.splice(0).forEach(clearTimeout)
        },
    }
}
