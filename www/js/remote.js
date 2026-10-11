// Runs the shell scripts in www/scripts on the VPS and parses their output.
window.Remote = (function () {
  var cache = {};
  var handlers = {};

  function load(name) {
    if (cache[name]) return Promise.resolve(cache[name]);
    return fetch('scripts/' + name + '.sh').then(function (r) {
      if (!r.ok) throw new Error('Missing script: ' + name);
      return r.text();
    }).then(function (t) { cache[name] = t; return t; });
  }

  function build(name) {
    return Promise.all([load('prelude'), load(name)]).then(function (a) {
      return a[0] + '\n' + a[1];
    });
  }

  // listen once for streamed output
  function attach() {
    if (typeof Ssh.addListener !== 'function') return;
    Ssh.addListener('execData', function (e) {
      var h = handlers[e.id];
      if (h && h.onData) h.onData(e.data);
    });
    Ssh.addListener('execExit', function (e) {
      var h = handlers[e.id];
      if (h) { delete handlers[e.id]; h.onExit(e.code); }
    });
  }

  function run(name, timeoutMs) {
    return build(name).then(function (script) {
      return Ssh.exec({ command: script, timeoutMs: timeoutMs || 30000 });
    });
  }

  // run a script and stream its output; resolves with the exit code
  function stream(name, onData) {
    return build(name).then(function (script) {
      var id = 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      return new Promise(function (resolve, reject) {
        handlers[id] = { onData: onData, onExit: resolve };
        Ssh.execStream({ id: id, command: script }).catch(function (e) {
          delete handlers[id];
          reject(e);
        });
      });
    });
  }

  function parseKV(text) {
    var o = {};
    String(text || '').split('\n').forEach(function (line) {
      var i = line.indexOf('=');
      if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    return o;
  }

  function status() {
    return run('status', 25000).then(function (r) { return parseKV(r.stdout); });
  }

  return { attach: attach, run: run, stream: stream, status: status, parseKV: parseKV };
})();
